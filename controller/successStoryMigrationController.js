const {
    previewLearners,
    migrateLearners,
} = require('../service/learnerMigrationService');

async function previewLearnerMigration(req, res) {
    try {
        const result = await previewLearners({
            learnerId: req.params.learnerId,
        });

        if (result.totalSelected === 0) {
            return res.status(404).json({
                success: false,
                message: `No learner found for legacy learner id ${req.params.learnerId}.`,
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

async function migrateLearnersToNewSystem(req, res) {
    try {
        const learnerIds = normalizeLearnerIds(req.body.learnerIds);
        const result = await migrateLearners({
            learnerId: req.body.learnerId,
            learnerIds,
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

function normalizeLearnerIds(learnerIds) {
    if (!learnerIds) {
        return [];
    }

    if (Array.isArray(learnerIds)) {
        return learnerIds;
    }

    return [learnerIds];
}

module.exports = {
    previewLearnerMigration,
    migrateLearnersToNewSystem,
};
