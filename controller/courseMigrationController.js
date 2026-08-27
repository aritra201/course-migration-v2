const {
    previewCourses,
    migrateCourses,
} = require('../service/courseMigrationService');

async function previewCourseMigration(req, res) {
    try {
        const result = await previewCourses({
            courseId: req.params.courseId,
        });

        if (result.totalSelected === 0) {
            return res.status(404).json({
                success: false,
                message: `No course found for legacy course id ${req.params.courseId}.`,
            });
        }

        return res.status(200).json({
            success: true,
            ...result,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
}

async function migrateCoursesToNewSystem(req, res) {
    try {
        const courseIds = normalizeCourseIds(req.body.courseIds);
        const result = await migrateCourses({
            courseId: req.body.courseId,
            courseIds,
            limit: req.body.limit,
            offset: req.body.offset,
            dryRun: Boolean(req.body.dryRun),
        });

        return res.status(200).json({
            success: true,
            ...result,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
}

function normalizeCourseIds(courseIds) {
    if (!courseIds) {
        return [];
    }

    if (Array.isArray(courseIds)) {
        return courseIds;
    }

    return [courseIds];
}

module.exports = {
    previewCourseMigration,
    migrateCoursesToNewSystem,
};
