const fs = require('fs/promises');
const vm = require('vm');

const { getMigrationConfig } = require('../config/migrationConfig');
const {
    collectAllCsvRows,
    collectCsvRowsWhere,
    collectFirstNCsvRows,
    collectCsvRowsSlice,
    streamCsvRecords,
} = require('./csvParserService');
const { loadSectionDatasets, buildSectionContentMap } = require('./contentSectionService');

async function previewCourses(options = {}) {
    const courses = await buildMigratedCourses(options);
    const filtered = filterCourses(courses, options);

    return {
        totalAvailable: courses.length,
        totalSelected: filtered.length,
        courses: filtered,
    };
}

async function migrateCourses(options = {}) {
    const courses = await buildMigratedCourses(options);
    const selectedCourses = filterCourses(courses, options);
    const results = [];
    const config = getMigrationConfig();

    for (const course of selectedCourses) {
        if (course.meta.isDeleted) {
            results.push({
                legacyCourseId: course.meta.legacyCourseId,
                title: course.payload.title,
                success: false,
                skipped: true,
                dryRun: Boolean(options.dryRun),
                legacyStatus: course.meta.legacyStatus,
                message: 'Course is deleted (legacy status D) and was not migrated.',
            });
            continue;
        }

        if (options.dryRun) {
            results.push({
                legacyCourseId: course.meta.legacyCourseId,
                title: course.payload.title,
                success: true,
                dryRun: true,
                payload: course.payload,
            });
            continue;
        }

        let payload = { ...course.payload };
        const items = course.meta.studyMaterialItems || [];

        if (items.length > 0) {
            const uploadResult = await uploadStudyMaterialsForCourse(items, config);

            if (!uploadResult.ok) {
                results.push({
                    legacyCourseId: course.meta.legacyCourseId,
                    title: course.payload.title,
                    success: false,
                    status: uploadResult.status,
                    studyMaterialUploadError: uploadResult.body,
                });
                continue;
            }

            payload = {
                ...payload,
                study_material_mapping_ids: uploadResult.ids,
            };
        }

        const apiResponse = await createCourse(payload);

        results.push({
            legacyCourseId: course.meta.legacyCourseId,
            title: course.payload.title,
            success: apiResponse.ok,
            status: apiResponse.status,
            response: apiResponse.data,
        });
    }

    return {
        totalAvailable: courses.length,
        totalSelected: selectedCourses.length,
        batchOffset: resolveOffset(options.offset),
        batchLimit: options.limit != null && options.limit !== '' ? Number(options.limit) : null,
        successCount: results.filter((result) => result.success).length,
        skippedCount: results.filter((result) => result.skipped).length,
        failureCount: results.filter((result) => !result.success && !result.skipped).length,
        results,
    };
}

async function buildMigratedCourses(options = {}) {
    const dataset = await loadMigrationSourceData(options);
    const { courseRows, bannerRows, contentRows, courseTypeMap, mapping, sectionDatasets, downloadFilesByCourseId, courseBannerImageBaseUrl, studyMaterialThumbBaseUrl } =
        dataset;

    const bannerMap  = buildBannerMap(bannerRows);
    const contentMap = buildContentMap(contentRows);

    // Build an id-indexed map of tbl_course_content rows for section-based HTML rendering
    const contentRowsById = new Map(
        contentRows.map((r) => [String(r.id ?? '').trim(), r]),
    );
    const sectionContentMap = buildSectionContentMap(courseRows, contentRowsById, sectionDatasets);

    return courseRows.map((courseRow) => {
        const courseId    = String(courseRow.id ?? '').trim();
        const bannerRow   = bannerMap.get(courseRow.id) || {};
        const contentData = contentMap.get(courseRow.id) || createEmptyContentData(courseRow.id);
        const typeId      = String(courseRow.type_of_course ?? '').trim();
        const courseTypeRow = (typeId && courseTypeMap.get(typeId)) || {};
        const sectionHtml = sectionContentMap.get(courseId) || '';
        const coursePlanRows = sectionDatasets.coursePlanTypeMappingByCourseId?.get(courseId) || [];
        const bestPlanRow    = selectBestPlanRow(coursePlanRows);
        const coursePlanData = {
            course_plan_additional_price: resolveCourseAdditionalPrice(coursePlanRows),
            // currency → tbl_course_plan_type_mapping.curr_name
            // (courseRow has no currency column so the lookup falls through naturally)
            currency:            bestPlanRow ? cleanText(bestPlanRow.curr_name)     : '',
            // plan_original_price → tbl_course_plan_type_mapping.orginal_price
            // stored under a unique key so buildPayload can override payload.amount
            // without being shadowed by tbl_course.course_fee
            plan_original_price: bestPlanRow ? cleanText(bestPlanRow.orginal_price) : '',
        };

        const payload = buildPayload({
            mapping,
            courseRow,
            bannerRow,
            contentData,
            courseTypeRow,
            coursePlanData,
            sectionHtml,
            courseBannerImageBaseUrl,
        });

        return {
            meta: {
                legacyCourseId: courseRow.id,
                legacyStatus: cleanText(courseRow.status).toUpperCase(),
                isDeleted: isLegacyCourseDeleted(courseRow),
                sourceCourseName: courseRow.course_name || '',
                contentRowCount: contentData.rowCount,
                bannerFound: Boolean(Object.keys(bannerRow).length),
                studyMaterialItems: buildStudyMaterialUploadItems(courseId, downloadFilesByCourseId, studyMaterialThumbBaseUrl),
            },
            payload,
        };
    });
}

function isLegacyCourseDeleted(courseRow) {
    return String(courseRow?.status ?? '').trim().toUpperCase() === 'D';
}

function resolveMaxRows(limit) {
    if (limit == null || limit === '') {
        return Number.POSITIVE_INFINITY;
    }

    const n = Number(limit);

    if (!Number.isFinite(n) || n < 0) {
        return Number.POSITIVE_INFINITY;
    }

    return n;
}

function resolveOffset(offset) {
    if (offset == null || offset === '') {
        return 0;
    }

    const n = Number(offset);

    if (!Number.isFinite(n) || n < 0) {
        return 0;
    }

    return Math.floor(n);
}

/**
 * Loads course rows (respecting courseId / courseIds / limit) and only banner/content
 * rows for those courses, using streaming CSV reads to avoid holding multi‑MB files in memory twice.
 */
async function loadMigrationSourceData(options = {}) {
    const config = getMigrationConfig();
    const maxRows = resolveMaxRows(options.limit);

    if (maxRows === 0) {
        const mapping = await loadMapping(config.mappingFile);
        const courseTypeRows = await collectAllCsvRows(config.csv.courseType);
        return {
            courseRows: [],
            bannerRows: [],
            contentRows: [],
            sectionDatasets: {},
            courseTypeMap: buildCourseTypeMapById(courseTypeRows),
            mapping,
            downloadFilesByCourseId: new Map(),
            courseBannerImageBaseUrl: config.target.courseBannerImageBaseUrl,
            studyMaterialThumbBaseUrl: config.target.studyMaterialThumbBaseUrl,
        };
    }

    const [mapping, courseTypeRows, courseRows] = await Promise.all([
        loadMapping(config.mappingFile),
        collectAllCsvRows(config.csv.courseType),
        collectCourseRowsWithFilters(config.csv.course, options),
    ]);

    const idSetForRelated = new Set(
        courseRows.map((row) => String(row.id ?? '').trim()).filter(Boolean),
    );

    const [bannerRows, contentRows, sectionDatasets, downloadMappingRows] = await Promise.all([
        collectCsvRowsWhere(config.csv.banner, (row) =>
            idSetForRelated.has(String(row.course_id ?? '').trim()),
        ),
        collectCsvRowsWhere(config.csv.content, (row) =>
            idSetForRelated.has(String(row.course_id ?? '').trim()),
        ),
        loadSectionDatasets(config, idSetForRelated),
        collectCsvRowsWhere(config.csv.courseDownloadFilesMapping, (row) =>
            idSetForRelated.has(String(row.course_id ?? '').trim()),
        ),
    ]);

    return {
        courseRows,
        bannerRows,
        contentRows,
        sectionDatasets,
        courseTypeMap: buildCourseTypeMapById(courseTypeRows),
        mapping,
        downloadFilesByCourseId: groupDownloadFilesByCourseId(downloadMappingRows),
        courseBannerImageBaseUrl: config.target.courseBannerImageBaseUrl,
        studyMaterialThumbBaseUrl: config.target.studyMaterialThumbBaseUrl,
    };
}

async function collectCourseRowsWithFilters(filePath, options = {}) {
    const maxRows = resolveMaxRows(options.limit);

    if (options.courseId) {
        const courseId = String(options.courseId).trim();
        const rows = await collectCsvRowsWhere(
            filePath,
            (row) => String(row.id ?? '').trim() === courseId,
        );

        if (maxRows === Number.POSITIVE_INFINITY) {
            return rows;
        }

        return rows.slice(0, maxRows);
    }

    if (Array.isArray(options.courseIds) && options.courseIds.length > 0) {
        const idSet = new Set(options.courseIds.map((id) => String(id).trim()));
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

async function loadMapping(mappingFilePath) {
    const rawMapping = await fs.readFile(mappingFilePath, 'utf8');
    const mapping = vm.runInNewContext(`(${rawMapping})`);

    if (!mapping || typeof mapping !== 'object') {
        throw new Error('Mapping file did not return an object.');
    }

    return mapping;
}

function buildCourseTypeMapById(rows) {
    const map = new Map();

    for (const row of rows) {
        const id = String(row.id ?? '').trim();

        if (id) {
            map.set(id, row);
        }
    }

    return map;
}

/**
 * Group tbl_course_download_files_mapping rows by legacy course_id.
 */
function groupDownloadFilesByCourseId(rows) {
    const map = new Map();

    for (const row of rows) {
        const courseId = String(row.course_id ?? '').trim();
        if (!courseId) continue;

        if (!map.has(courseId)) {
            map.set(courseId, []);
        }

        map.get(courseId).push(row);
    }

    return map;
}

/**
 * Build payloads for POST /course/study-material/upload-url (ordered by mapping row id).
 */
function buildStudyMaterialUploadItems(courseId, downloadFilesByCourseId, studyMaterialThumbBaseUrl) {
    const rows = (downloadFilesByCourseId.get(courseId) || [])
        .filter((r) => String(r.status ?? '').trim().toUpperCase() === 'A');

    if (!rows.length) {
        return [];
    }

    rows.sort((a, b) => Number(a.id) - Number(b.id));

    return rows.map((r) => {
        const fileName = cleanText(r.file_name_value);
        if (!fileName) {
            return null;
        }

        const enc = encodeURIComponent(fileName);
        const baseUrl = cleanText(studyMaterialThumbBaseUrl).replace(/\/+$/, '');

        return {
            study_material_file_url: `${baseUrl}/${enc}`,
            file_name: fileName,
        };
    }).filter(Boolean);
}

function resolveStudyMaterialUploadUrl(config) {
    if (config.target.studyMaterialUploadUrl) {
        return cleanText(config.target.studyMaterialUploadUrl);
    }

    const base = cleanText(config.target.baseUrl);
    if (!base) {
        return '';
    }

    return base.replace(/\/add\/?$/i, '/study-material/upload-url');
}

async function uploadStudyMaterialsForCourse(items, config) {
    const url = resolveStudyMaterialUploadUrl(config);

    if (!url || !items.length) {
        return { ok: true, ids: [], skipped: !items.length };
    }

    const auth = buildAuthHeaders(config.target.token);
    const headers = { 'Content-Type': 'application/json' };
    if (auth.Authorization) {
        headers.Authorization = auth.Authorization;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(items),
    });

    const body = await readResponseBody(response);

    if (!response.ok) {
        return { ok: false, ids: [], status: response.status, body };
    }

    const dataArr = body && body.data;
    const ids = Array.isArray(dataArr)
        ? dataArr.map((d) => d && d.id).filter((id) => id != null && id !== '')
        : [];

    return { ok: true, ids, status: response.status, body };
}

function buildBannerMap(rows) {
    const grouped = new Map();

    for (const row of rows) {
        if (!grouped.has(row.course_id)) {
            grouped.set(row.course_id, []);
        }

        grouped.get(row.course_id).push(row);
    }

    return new Map(
        Array.from(grouped.entries()).map(([courseId, bannerRows]) => [
            courseId,
            selectBestBannerRow(bannerRows),
        ]),
    );
}

function selectBestBannerRow(rows) {
    return [...rows].sort(compareBannerRows)[0] || {};
}

function compareBannerRows(left, right) {
    return (
        compareBooleanFlag(right.use_as_listing, left.use_as_listing) ||
        comparePrimaryBanner(right.banner_type, left.banner_type) ||
        compareActiveStatus(right.status, left.status) ||
        compareDate(right.modified_date, left.modified_date) ||
        compareNumber(right.id, left.id)
    );
}

function compareBooleanFlag(left, right) {
    return normalizeBoolean(left) - normalizeBoolean(right);
}

function comparePrimaryBanner(left, right) {
    return Number(String(left).toLowerCase() === 'primary') - Number(String(right).toLowerCase() === 'primary');
}

function compareActiveStatus(left, right) {
    return Number(String(left).toUpperCase() === 'A') - Number(String(right).toUpperCase() === 'A');
}

function compareDate(left, right) {
    return new Date(left || 0).getTime() - new Date(right || 0).getTime();
}

function compareNumber(left, right) {
    return Number(left || 0) - Number(right || 0);
}

/**
 * Pick the first active plan row ordered by course_plan_position then id.
 * Used to extract authoritative currency and original-price values.
 */
function selectBestPlanRow(coursePlanRows) {
    return (
        [...coursePlanRows]
            .filter((row) => cleanText(row.status).toUpperCase() === 'A')
            .sort(
                (a, b) =>
                    compareNumber(a.course_plan_position, b.course_plan_position) ||
                    compareNumber(a.id, b.id),
            )[0] || null
    );
}

function resolveCourseAdditionalPrice(coursePlanRows) {
    const selectedRow = [...coursePlanRows]
        .filter((row) => (
            cleanText(row.status).toUpperCase() === 'A' &&
            Boolean(cleanText(row.additional_price))
        ))
        .sort((left, right) => (
            compareNumber(left.course_plan_position, right.course_plan_position) ||
            compareNumber(left.id, right.id)
        ))[0];

    return selectedRow ? selectedRow.additional_price : '';
}

function buildContentMap(rows) {
    const grouped = new Map();

    for (const row of rows) {
        if (!grouped.has(row.course_id)) {
            grouped.set(row.course_id, []);
        }

        grouped.get(row.course_id).push(row);
    }

    return new Map(
        Array.from(grouped.entries()).map(([courseId, contentRows]) => [
            courseId,
            mergeContentRows(courseId, contentRows),
        ]),
    );
}

function mergeContentRows(courseId, rows) {
    const orderedRows = [...rows].sort((left, right) => compareNumber(left.id, right.id));

    const sections = orderedRows
        .map((row) => renderContentSection(row.content_title, row.content_details))
        .filter(Boolean);

    return {
        course_id: courseId,
        rowCount: orderedRows.length,
        content_details: sections.join('\n\n'),
        content_title: orderedRows
            .map((row) => cleanText(row.content_title))
            .filter(Boolean)
            .join(' | '),
        merged_content: sections.join('\n\n'),
    };
}

function renderContentSection(title, details) {
    const cleanTitle = cleanText(title);
    const cleanDetails = cleanText(details);

    if (!cleanTitle && !cleanDetails) {
        return '';
    }

    if (cleanTitle && cleanDetails) {
        return `<section><h2>${escapeHtml(cleanTitle)}</h2>${cleanDetails}</section>`;
    }

    if (cleanTitle) {
        return `<section><h2>${escapeHtml(cleanTitle)}</h2></section>`;
    }

    return cleanDetails;
}

function buildPayload({ mapping, courseRow, bannerRow, contentData, courseTypeRow = {}, coursePlanData = {}, sectionHtml = '', courseBannerImageBaseUrl = '' }) {
    const payload = {};

    for (const [targetField, rule] of Object.entries(mapping)) {
        payload[targetField] = resolveMappedValue(rule, {
            courseRow,
            bannerRow,
            contentData,
            courseTypeRow,
            coursePlanData,
        });
    }

    // amount: the mapping rule "course_fee" resolves to courseRow.course_fee first because
    // tbl_course.csv has that column.  Override here so the authoritative source is
    // tbl_course_plan_type_mapping.orginal_price (stored as plan_original_price in coursePlanData).
    if ('plan_original_price' in coursePlanData) {
        payload.amount = coursePlanData.plan_original_price;
    }

    payload.slug = payload.slug || slugify(payload.title || courseRow.url_mask || courseRow.course_name || '');
    payload.title = payload.title || courseRow.course_name || '';
    // sectionHtml is built from tbl_course_section_type_mapping ordered by section_position,
    // mirroring the legacy PHP CourseLib::getSections() algorithm.
    // Falls back to the flat merged_content if no section data is available.
    payload.course_content = sectionHtml || payload.course_content || contentData.merged_content || '';
    payload.header_tag_snippets = normalizeJsonArray(payload.header_tag_snippets);
    payload.footer_tag_snippets = normalizeJsonArray(payload.footer_tag_snippets);
    payload.course_tags = normalizeCourseTags(payload.course_tags);
    payload.banner_url = buildBannerUrl(courseBannerImageBaseUrl, payload.banner_url);
    payload.third_party_lead_enabled = resolveThirdPartyLeadEnabled(payload.third_party_lead_enabled);

    return normalizePayload(payload, {
        courseRow,
        bannerRow,
        contentData,
        courseTypeRow,
        coursePlanData,
    });
}

function resolveMappedValue(rule, context) {
    if (typeof rule !== 'string') {
        return rule;
    }

    const trimmedRule = rule.trim();

    if (trimmedRule === '') {
        return '';
    }

    if (trimmedRule === 'true') {
        return true;
    }

    if (trimmedRule === 'false') {
        return false;
    }

    if (trimmedRule === 'content_title+content_details') {
        return context.contentData.merged_content || '';
    }

    if (trimmedRule.includes('+')) {
        return trimmedRule
            .split('+')
            .map((part) => resolveColumnValue(part.trim(), context))
            .filter((value) => cleanText(value))
            .join(' ');
    }

    return resolveColumnValue(trimmedRule, context);
}

function resolveColumnValue(columnName, { courseRow, bannerRow, contentData, courseTypeRow = {}, coursePlanData = {} }) {
    if (Object.prototype.hasOwnProperty.call(courseRow, columnName)) {
        return courseRow[columnName];
    }

    if (Object.prototype.hasOwnProperty.call(bannerRow, columnName)) {
        return bannerRow[columnName];
    }

    if (Object.prototype.hasOwnProperty.call(contentData, columnName)) {
        return contentData[columnName];
    }

    if (Object.prototype.hasOwnProperty.call(courseTypeRow, columnName)) {
        return courseTypeRow[columnName];
    }

    if (Object.prototype.hasOwnProperty.call(coursePlanData, columnName)) {
        return coursePlanData[columnName];
    }

    return '';
}

function normalizePayload(payload, sourceContext = {}) {
    const booleanFields = new Set([
        'is_published',
        'payment_enabled',
        'third_party_lead_enabled',
        'share_enabled',
        'is_new',
        'is_featured',
        'get_study_material_enabled',
        'use_custom_study_material_template',
        'counselling_call_enabled',
        'join_waitlist_enabled',
        'use_custom_join_waitlist_email_template',
        'show_banner_phone',
        'show_banner_tagline',
        'show_learn_from',
        'show_get_course_syllabus',
        'refund_policy',
        'send_to_timepay',
        'send_to_leadsquared',
        'send_to_wati',
        'send_to_email',
    ]);

    const numberFields = new Set(['amount']);
    const integerFields = new Set([
        'old_course_id',
        'ap_portal_course_id',
        'ap_portal_course_catagory_id',
    ]);

    for (const key of Object.keys(payload)) {
        if (booleanFields.has(key)) {
            if (key === 'is_published') {
                // courseMap maps legacy hide_from_list: Y = hide from list, N = show in list.
                // Target is_published: true = visible/published on listing.
                payload[key] = normalizeIsPublishedFromHideFromList(payload[key]);
            } else {
                payload[key] = normalizeBoolean(payload[key]);
            }
            continue;
        }

        if (numberFields.has(key)) {
            payload[key] = normalizeAmount(payload[key]);
            continue;
        }

        if (key === 'additional_price') {
            payload[key] = normalizeNullableAmount(payload[key]);
            continue;
        }

        if (key === 'hide_last_enrollment_date') {
            // Inverse of show_enroll_close_date: Y → send N, N → send Y
            payload[key] = cleanText(payload[key]).toUpperCase() === 'Y' ? 'N' : 'Y';
            continue;
        }

        if (key === 'hide_from_list') {
            payload[key] = normalizeHideFromList(payload[key]);
            continue;
        }

        if (key === 'location_short_name') {
            payload[key] = cleanText(payload[key]).toUpperCase() || 'IN';
            continue;
        }

        if (integerFields.has(key)) {
            payload[key] = normalizeOptionalInteger(payload[key]);
            continue;
        }

        if (key === 'currency') {
            payload[key] = cleanText(payload[key]) || 'INR';
            continue;
        }

        if (key === 'duration_minutes') {
            payload[key] = normalizeDurationMinutes(
                payload[key],
                sourceContext.courseRow?.duration_type || sourceContext.bannerRow?.duration_type || '',
            );
            continue;
        }

        if (key === 'status') {
            payload[key] = normalizeStatus(payload[key]);
            continue;
        }

        if (key === 'enrollment_last_date') {
            payload[key] = normalizeDate(payload[key]);
            continue;
        }

        if (key === 'logo_type') {
            payload[key] = normalizeLogoType(payload[key]);
            continue;
        }

        if (typeof payload[key] === 'string') {
            payload[key] = cleanText(payload[key]);
        }
    }

    return payload;
}

async function createCourse(payload) {
    const config = getMigrationConfig();
    const formData = new FormData();

    for (const [key, value] of Object.entries(payload)) {
        formData.append(key, serializeFormValue(value));
    }

    const headers = buildAuthHeaders(config.target.token);

    const response = await fetch(config.target.baseUrl, {
        method: 'POST',
        headers,
        body: formData,
    });

    const responseBody = await readResponseBody(response);

    return {
        ok: response.ok,
        status: response.status,
        data: responseBody,
    };
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

function filterCourses(courses, options) {
    let filtered = [...courses];

    if (options.courseId) {
        filtered = filtered.filter((course) => String(course.meta.legacyCourseId) === String(options.courseId));
    }

    if (Array.isArray(options.courseIds) && options.courseIds.length > 0) {
        const idSet = new Set(options.courseIds.map(String));
        filtered = filtered.filter((course) => idSet.has(String(course.meta.legacyCourseId)));
    }

    if (options.limit) {
        filtered = filtered.slice(0, Number(options.limit));
    }

    return filtered;
}

function normalizeCourseTags(value) {
    const cleanValue = cleanText(value);

    if (!cleanValue) {
        return '[]';
    }

    const tags = cleanValue
        .split(',')
        .map((tag) => cleanText(tag))
        .filter(Boolean);

    return JSON.stringify(tags);
}

function resolveThirdPartyLeadEnabled(value) {
    const cleanValue = cleanText(value).toLowerCase();

    if (cleanValue === '') {
        return true;
    }

    if (['y', 'yes', 'true', '1'].includes(cleanValue)) {
        return true;
    }

    if (['n', 'no', 'false', '0'].includes(cleanValue)) {
        return false;
    }

    return true;
}

function normalizeJsonArray(value) {
    const cleanValue = cleanText(value);
    return cleanValue || '[]';
}

function normalizeBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    const normalized = String(value || '').trim().toLowerCase();

    if (['y', 'yes', 'true', '1', 'a'].includes(normalized)) {
        return true;
    }

    if (normalized === 'n' || normalized === 'false' || normalized === '0') {
        return false;
    }

    return false;
}

/** Legacy hide_from_list → target is_published (inverse of plain Y/N “yes” semantics). */
function normalizeIsPublishedFromHideFromList(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    const normalized = String(value || '').trim().toLowerCase();

    if (['y', 'yes', 'true', '1', 'a'].includes(normalized)) {
        return false;
    }

    if (normalized === 'n' || normalized === 'no' || normalized === 'false' || normalized === '0') {
        return true;
    }

    return false;
}

function normalizeHideFromList(value) {
    return cleanText(value).toUpperCase() === 'Y' ? 'Y' : 'N';
}

function normalizeLogoType(value) {
    return cleanText(value);
}

function normalizeAmount(value) {
    const numericValue = Number.parseFloat(String(value || '').replace(/,/g, ''));
    return Number.isFinite(numericValue) ? numericValue : 0;
}

function normalizeNullableAmount(value) {
    const cleanValue = cleanText(value);

    if (!cleanValue) {
        return null;
    }

    const numericValue = Number.parseFloat(cleanValue.replace(/,/g, ''));
    return Number.isFinite(numericValue) ? numericValue : null;
}

function normalizeOptionalInteger(value) {
    const cleanValue = cleanText(value);

    if (!cleanValue) {
        return '';
    }

    const numericValue = Number.parseInt(cleanValue, 10);
    return Number.isFinite(numericValue) ? numericValue : '';
}

function normalizeDurationMinutes(durationValue, durationType) {
    const numericDuration = Number.parseFloat(String(durationValue || '').replace(/,/g, '').trim());

    if (!Number.isFinite(numericDuration)) {
        return cleanText(durationValue);
    }

    const normalizedType = cleanText(durationType).toLowerCase();

    if (normalizedType === 'days' || normalizedType === 'day') {
        return String(Math.round(numericDuration * 24 * 60));
    }

    if (normalizedType === 'months' || normalizedType === 'month') {
        // Use exactly 30 days/month so the new system displays a round figure.
        // 30.4166667 (astronomical average) caused "6 months 2 days" instead of "6 months".
        return String(Math.round(numericDuration * 30 * 24 * 60));
    }

    if (normalizedType === 'years' || normalizedType === 'year' || normalizedType === 'yr' || normalizedType === 'yrs') {
        // Use 360 days/year (12 × 30) to stay consistent with the 30-day month convention.
        return String(Math.round(numericDuration * 12 * 30 * 24 * 60));
    }

    return String(Math.round(numericDuration));
}

function normalizeStatus(value) {
    const normalized = String(value || '').trim().toUpperCase();

    if (['A', 'P', 'D'].includes(normalized)) {
        return normalized;
    }

    if (normalized === '') {
        return 'P';
    }

    return 'P';
}

function normalizeDate(value) {
    const cleanValue = cleanText(value);

    if (!cleanValue || cleanValue.toUpperCase() === 'NULL') {
        return '';
    }

    const date = new Date(cleanValue);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function serializeFormValue(value) {
    if (value === null || value === undefined) {
        return '';
    }

    if (typeof value === 'boolean') {
        return String(value);
    }

    if (typeof value === 'number') {
        return String(value);
    }

    if (Array.isArray(value)) {
        return JSON.stringify(value);
    }

    return String(value);
}

function slugify(value) {
    return String(value || '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function buildBannerUrl(baseUrl, imageName) {
    const cleanImageName = cleanText(imageName);

    if (!cleanImageName) {
        return '';
    }

    if (/^https?:\/\//i.test(cleanImageName)) {
        return cleanImageName;
    }

    const cleanBaseUrl = cleanText(baseUrl).replace(/\/+$/, '');
    const cleanPath = cleanImageName.replace(/^\/+/, '');

    return cleanBaseUrl ? `${cleanBaseUrl}/${cleanPath}` : cleanPath;
}

function createEmptyContentData(courseId) {
    return {
        course_id: courseId,
        rowCount: 0,
        content_details: '',
        content_title: '',
        merged_content: '',
    };
}

function cleanText(value) {
    if (value === null || value === undefined) {
        return '';
    }

    const stringValue = String(value);
    return stringValue.toUpperCase() === 'NULL' ? '' : stringValue.trim();
}

function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = {
    previewCourses,
    migrateCourses,
};
