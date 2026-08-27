const express = require('express');

const {
    previewCourseMigration,
    migrateCoursesToNewSystem,
} = require('../controller/courseMigrationController');

const router = express.Router();

router.get('/preview/:courseId', previewCourseMigration);
router.post('/migrate', migrateCoursesToNewSystem);

module.exports = router;
