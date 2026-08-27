const fs = require('fs/promises');
const vm = require('vm');

const { getSuccessStoryMigrationConfig } = require('../config/successStoryMigrationConfig');
const {
    collectAllCsvRows,
    collectCsvRowsSlice,
    collectCsvRowsWhere,
    streamCsvRecords,
} = require('./csvParserService');

const IMAGE_FIELDS = new Set([
    'profile_image',
    'pre_profession_logo',
    'post_profession_logo',
    'youtube_image',
]);

const DATETIME_FIELDS = new Set(['createdAt', 'updatedAt']);

async function previewLearners(options = {}) {
    const learners = await buildMigratedLearners(options);
    const filtered = filterLearners(learners, options);

    return {
        totalAvailable: learners.length,
        totalSelected: filtered.length,
        learners: filtered,
    };
}

async function migrateLearners(options = {}) {
    const learners = await buildMigratedLearners(options);
    const selectedLearners = filterLearners(learners, options);
    const results = [];
    const config = getSuccessStoryMigrationConfig();

    for (const learner of selectedLearners) {
        if (learner.meta.isDeleted) {
            results.push({
                legacyLearnerId: learner.meta.legacyLearnerId,
                name: learner.payload.name,
                success: false,
                skipped: true,
                dryRun: Boolean(options.dryRun),
                legacyStatus: learner.meta.legacyStatus,
                message: 'Learner is deleted (legacy status D) and was not migrated.',
            });
            continue;
        }

        if (learner.meta.unmappedEnrollments.length > 0) {
            results.push({
                legacyLearnerId: learner.meta.legacyLearnerId,
                name: learner.payload.name,
                success: false,
                skipped: true,
                dryRun: Boolean(options.dryRun),
                unmappedEnrollments: learner.meta.unmappedEnrollments,
                message: 'One or more course enrollments could not be mapped to the new system.',
            });
            continue;
        }

        if (options.dryRun) {
            results.push({
                legacyLearnerId: learner.meta.legacyLearnerId,
                name: learner.payload.name,
                success: true,
                dryRun: true,
                payload: learner.payload,
                courseEnrollmentMapping: learner.meta.courseEnrollmentMapping,
            });
            continue;
        }

        const apiResponse = await createLearner(learner.payload, config);

        results.push({
            legacyLearnerId: learner.meta.legacyLearnerId,
            name: learner.payload.name,
            success: apiResponse.ok,
            status: apiResponse.status,
            sentPayload: learner.payload,
            response: apiResponse.data,
        });
    }

    return {
        totalAvailable: learners.length,
        totalSelected: selectedLearners.length,
        batchOffset: resolveOffset(options.offset),
        batchLimit: options.limit != null && options.limit !== '' ? Number(options.limit) : null,
        successCount: results.filter((result) => result.success).length,
        skippedCount: results.filter((result) => result.skipped).length,
        failureCount: results.filter((result) => !result.success && !result.skipped).length,
        results,
    };
}

async function buildMigratedLearners(options = {}) {
    const dataset = await loadMigrationSourceData(options);
    const { learnerRows, mapping, courseMappingContext, imagePrefixes } = dataset;

    return learnerRows.map((learnerRow) => {
        const { payload, unmappedEnrollments, courseEnrollmentMapping } = buildLearnerPayload({
            mapping,
            learnerRow,
            courseMappingContext,
            imagePrefixes,
        });

        return {
            meta: {
                legacyLearnerId: learnerRow.id,
                legacyStatus: cleanText(learnerRow.status).toUpperCase(),
                isDeleted: isLegacyLearnerDeleted(learnerRow),
                sourceLearnerName: learnerRow.learner_name || '',
                sourceLearnerEmail: learnerRow.learner_email || '',
                unmappedEnrollments,
                courseEnrollmentMapping,
            },
            payload,
        };
    });
}

function buildLearnerPayload({
    mapping,
    learnerRow,
    courseMappingContext,
    imagePrefixes,
}) {
    const payload = {};

    for (const [targetField, sourceField] of Object.entries(mapping)) {
        if (targetField === 'course_enrollments') {
            continue;
        }

        const rawValue = learnerRow[sourceField];

        if (IMAGE_FIELDS.has(targetField)) {
            const filename = cleanText(rawValue);
            const prefix = imagePrefixes[targetField] || '';

            if (filename && prefix) {
                payload[targetField] = `${prefix}${filename}`;
            }

            continue;
        }

        if (DATETIME_FIELDS.has(targetField)) {
            const isoDate = normalizeDateTime(rawValue);

            if (isoDate) {
                payload[targetField] = isoDate;
            }

            continue;
        }

        payload[targetField] = cleanText(rawValue);
    }

    const rawEnrollments = parseLearnerCourseBatch(learnerRow[mapping.course_enrollments]);
    const { mapped, unmapped, mappingDetails } = mapCourseEnrollments(
        rawEnrollments,
        courseMappingContext,
    );

    payload.course_enrollments = mapped;

    return {
        payload,
        unmappedEnrollments: unmapped,
        courseEnrollmentMapping: mappingDetails,
    };
}

function mapCourseEnrollments(enrollments, courseMappingContext) {
    const mapped = [];
    const unmapped = [];
    const mappingDetails = [];

    for (const enrollment of enrollments) {
        const oldCourseId = String(enrollment.course_id ?? '').trim();

        if (!oldCourseId) {
            unmapped.push({
                enrollment,
                reason: 'Missing legacy course_id.',
            });
            continue;
        }

        const resolved = resolveLegacyCourseId(oldCourseId, courseMappingContext);

        if (!resolved.ok) {
            unmapped.push({
                oldCourseId,
                enrollment,
                reason: resolved.reason,
                legacyUrlMask: resolved.legacyUrlMask || null,
            });
            continue;
        }

        mappingDetails.push({
            legacyCourseId: oldCourseId,
            legacyCourseName: resolved.legacyCourseName,
            legacyUrlMask: resolved.legacyUrlMask,
            newCourseId: Number(resolved.newCourseId),
            newCourseTitle: resolved.newCourseTitle,
            newUrlMasking: resolved.newUrlMasking,
            matchedBy: resolved.matchedBy,
            batch_id: normalizeBatchId(enrollment.batch_id),
            batch_name: cleanText(enrollment.batch_name),
        });

        mapped.push({
            course_id: Number(resolved.newCourseId),
            batch_id: normalizeBatchId(enrollment.batch_id),
            batch_name: cleanText(enrollment.batch_name),
        });
    }

    return { mapped, unmapped, mappingDetails };
}

function resolveLegacyCourseId(legacyCourseId, courseMappingContext) {
    const legacyCourse = courseMappingContext.legacyCourseById.get(legacyCourseId);

    if (!legacyCourse) {
        return {
            ok: false,
            reason: `Legacy course id ${legacyCourseId} not found in tbl_course.`,
        };
    }

    const legacyUrlMask = legacyCourse.urlMask;

    if (!legacyUrlMask) {
        return {
            ok: false,
            legacyUrlMask: '',
            reason: `Legacy course id ${legacyCourseId} has no url_mask in tbl_course.`,
        };
    }

    const newCourse = findNewCourseByLegacyUrlMask(legacyUrlMask, courseMappingContext);

    if (!newCourse) {
        return {
            ok: false,
            legacyUrlMask,
            reason: `No matching new course found for url_mask "${legacyUrlMask}".`,
        };
    }

    return {
        ok: true,
        legacyCourseName: legacyCourse.courseName,
        legacyUrlMask,
        newCourseId: newCourse.id,
        newCourseTitle: newCourse.title,
        newUrlMasking: newCourse.urlMasking,
        matchedBy: newCourse.matchedBy,
    };
}

function findNewCourseByLegacyUrlMask(legacyUrlMask, courseMappingContext) {
    const normalizedLegacyUrlMask = normalizeUrlKey(legacyUrlMask);

    if (!normalizedLegacyUrlMask) {
        return null;
    }

    return (
        courseMappingContext.newCourseByUrlKey.get(normalizedLegacyUrlMask) || null
    );
}

function buildCourseMappingContext(courseRows, newCourseRows) {
    const legacyCourseById = buildLegacyCourseByIdMap(courseRows);
    const newCourseByUrlKey = buildNewCourseByUrlKeyMap(newCourseRows);

    return {
        legacyCourseById,
        newCourseByUrlKey,
    };
}

function buildLegacyCourseByIdMap(courseRows) {
    const map = new Map();

    for (const row of courseRows) {
        const id = String(row.id ?? '').trim();

        if (!id) {
            continue;
        }

        map.set(id, {
            urlMask: cleanText(row.url_mask),
            courseName: cleanText(row.course_name),
        });
    }

    return map;
}

function buildNewCourseByUrlKeyMap(newCourseRows) {
    const map = new Map();

    for (const row of newCourseRows) {
        const id = String(row.id ?? '').trim();
        const urlMasking = cleanText(row.url_masking);
        const slug = cleanText(row.slug);
        const entry = {
            id,
            title: cleanText(row.title),
            urlMasking,
            slug,
        };

        const urlMaskingKey = normalizeUrlKey(urlMasking);
        if (urlMaskingKey && !map.has(urlMaskingKey)) {
            map.set(urlMaskingKey, { ...entry, matchedBy: 'url_masking' });
        }

        const slugKey = normalizeUrlKey(slug);
        if (slugKey && !map.has(slugKey)) {
            map.set(slugKey, { ...entry, matchedBy: 'slug' });
        }
    }

    return map;
}

function normalizeUrlKey(value) {
    return cleanText(value).toLowerCase();
}

function normalizeBatchId(value) {
    const cleanValue = cleanText(value);

    if (!cleanValue) {
        return cleanValue;
    }

    const numericValue = Number.parseInt(cleanValue, 10);
    return Number.isFinite(numericValue) ? numericValue : cleanValue;
}

function parseLearnerCourseBatch(rawValue) {
    const cleanValue = cleanText(rawValue);

    if (!cleanValue) {
        return [];
    }

    try {
        const parsed = JSON.parse(cleanValue);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function loadMigrationSourceData(options = {}) {
    const config = getSuccessStoryMigrationConfig();
    const maxRows = resolveMaxRows(options.limit);

    if (maxRows === 0) {
        const mapping = await loadLearnerMapping(config.mappingFile);

        return {
            learnerRows: [],
            mapping,
            courseMappingContext: buildCourseMappingContext([], []),
            imagePrefixes: config.imagePrefixes,
        };
    }

    const [mapping, courseRows, newCourseRows, learnerRows] = await Promise.all([
        loadLearnerMapping(config.mappingFile),
        collectAllCsvRows(config.csv.course),
        collectAllCsvRows(config.csv.newCourse),
        collectLearnerRowsWithFilters(config.csv.learner, options),
    ]);

    return {
        learnerRows,
        mapping,
        courseMappingContext: buildCourseMappingContext(courseRows, newCourseRows),
        imagePrefixes: config.imagePrefixes,
    };
}

async function collectLearnerRowsWithFilters(filePath, options = {}) {
    const maxRows = resolveMaxRows(options.limit);

    if (options.learnerId) {
        const learnerId = String(options.learnerId).trim();
        const rows = await collectCsvRowsWhere(
            filePath,
            (row) => String(row.id ?? '').trim() === learnerId,
        );

        if (maxRows === Number.POSITIVE_INFINITY) {
            return rows;
        }

        return rows.slice(0, maxRows);
    }

    if (Array.isArray(options.learnerIds) && options.learnerIds.length > 0) {
        const idSet = new Set(options.learnerIds.map((id) => String(id).trim()));
        const matched = [];

        await streamCsvRecords(filePath, (row) => {
            if (!idSet.has(String(row.id ?? '').trim())) {
                return true;
            }

            matched.push(row);

            if (maxRows !== Number.POSITIVE_INFINITY && matched.length >= maxRows) {
                return false;
            }

            return true;
        });

        return matched;
    }

    const offset = resolveOffset(options.offset);

    if (offset > 0 || maxRows !== Number.POSITIVE_INFINITY) {
        return collectCsvRowsSlice(filePath, offset, maxRows);
    }

    return collectAllCsvRows(filePath);
}

async function loadLearnerMapping(mappingFilePath) {
    const rawMapping = await fs.readFile(mappingFilePath, 'utf8');
    const marker = '// CSV to API payload mapping example';
    const markerIndex = rawMapping.indexOf(marker);

    if (markerIndex === -1) {
        throw new Error('Could not find mapping marker in learner-mapping.json.');
    }

    const start = rawMapping.indexOf('{', markerIndex);
    const end = rawMapping.lastIndexOf('}');

    if (start === -1 || end === -1 || end <= start) {
        throw new Error('Could not find mapping object in learner-mapping.json.');
    }

    const mappingBlock = rawMapping.slice(start, end + 1);
    const mapping = vm.runInNewContext(`(${mappingBlock})`);

    if (!mapping || typeof mapping !== 'object') {
        throw new Error('Learner mapping file did not return an object.');
    }

    return mapping;
}

async function createLearner(payload, config) {
    const headers = {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(config.target.token),
    };

    const response = await fetch(config.target.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    const responseBody = await readResponseBody(response);

    return {
        ok: response.ok,
        status: response.status,
        data: responseBody,
    };
}

function filterLearners(learners, options) {
    let filtered = [...learners];

    if (options.learnerId) {
        filtered = filtered.filter(
            (learner) => String(learner.meta.legacyLearnerId) === String(options.learnerId),
        );
    }

    if (Array.isArray(options.learnerIds) && options.learnerIds.length > 0) {
        const idSet = new Set(options.learnerIds.map(String));
        filtered = filtered.filter((learner) => idSet.has(String(learner.meta.legacyLearnerId)));
    }

    if (options.limit) {
        filtered = filtered.slice(0, Number(options.limit));
    }

    return filtered;
}

function isLegacyLearnerDeleted(learnerRow) {
    return String(learnerRow?.status ?? '').trim().toUpperCase() === 'D';
}

function resolveMaxRows(limit) {
    if (limit == null || limit === '') {
        return Number.POSITIVE_INFINITY;
    }

    const numericLimit = Number(limit);

    if (!Number.isFinite(numericLimit) || numericLimit < 0) {
        return Number.POSITIVE_INFINITY;
    }

    return numericLimit;
}

function resolveOffset(offset) {
    if (offset == null || offset === '') {
        return 0;
    }

    const numericOffset = Number(offset);

    if (!Number.isFinite(numericOffset) || numericOffset < 0) {
        return 0;
    }

    return Math.floor(numericOffset);
}

function buildAuthHeaders(token) {
    const cleanToken = cleanText(token);

    if (!cleanToken) {
        return {};
    }

    const authorizationValue = cleanToken.toLowerCase().startsWith('bearer ')
        ? cleanToken
        : `Bearer ${cleanToken}`;

    return {
        Authorization: authorizationValue,
        token: cleanToken,
    };
}

async function readResponseBody(response) {
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
        return response.json();
    }

    return response.text();
}

function cleanText(value) {
    if (value === null || value === undefined) {
        return '';
    }

    const stringValue = String(value);
    return stringValue.toUpperCase() === 'NULL' ? '' : stringValue.trim();
}

function normalizeDateTime(value) {
    const cleanValue = cleanText(value);

    if (!cleanValue) {
        return '';
    }

    const normalized = cleanValue.includes('T') ? cleanValue : cleanValue.replace(' ', 'T');
    const withTimeZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
    const date = new Date(withTimeZone);

    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

module.exports = {
    previewLearners,
    migrateLearners,
};
