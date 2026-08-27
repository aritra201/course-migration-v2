const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const ROOT_DIR = process.cwd();
const SUCCESS_STORY_DIR = path.join(ROOT_DIR, 'success-story-migration');

function getRequiredEnv(name) {
    const value = process.env[name];

    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return value;
}

function getSuccessStoryMigrationConfig() {
    const imageBaseUrl = getRequiredEnv('SUCCESS_STORY_IMAGE_BASE_URL')
        .trim()
        .replace(/\/+$/, '');

    return {
        rootDir: ROOT_DIR,
        csv: {
            learner: path.join(SUCCESS_STORY_DIR, 'tbl_lawsikho_learner.csv'),
            course: path.join(SUCCESS_STORY_DIR, 'tbl_course.csv'),
            newCourse: path.join(SUCCESS_STORY_DIR, 'tbl_new_course.csv'),
        },
        mappingFile: path.join(SUCCESS_STORY_DIR, 'learner-mapping.json'),
        imagePrefixes: {
            profile_image: `${imageBaseUrl}/uploads/learner_profile_image/thumbs/`,
            pre_profession_logo: `${imageBaseUrl}/uploads/learner_pre_profession_logo/thumbs/`,
            post_profession_logo: `${imageBaseUrl}/uploads/learner_post_profession_logo/thumbs/`,
            youtube_image: `${imageBaseUrl}/uploads/learner_youtube_image/thumbs/`,
        },
        target: {
            baseUrl: process.env.LEARNER_API_URL || 'http://localhost:6608/api/v1/learners/migrate',
            token: getRequiredEnv('TOKEN'),
        },
    };
}

module.exports = {
    getSuccessStoryMigrationConfig,
};
