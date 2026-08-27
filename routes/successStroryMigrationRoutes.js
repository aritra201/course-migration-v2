const express = require('express');

const {
    previewLearnerMigration,
    migrateLearnersToNewSystem,
} = require('../controller/successStoryMigrationController');

const router = express.Router();

router.get('/preview/:learnerId', previewLearnerMigration);
router.post('/migrate', migrateLearnersToNewSystem);

module.exports = router;
