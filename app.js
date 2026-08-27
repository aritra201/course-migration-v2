const express = require('express');
const colors = require('colors');
const dotenv = require('dotenv');
const cors = require('cors');
const courseMigrationRoutes = require('./routes/courseMigrationRoutes');
const successStoryMigrationRoutes = require('./routes/successStroryMigrationRoutes');
const app = express();

app.use(cors());

dotenv.config();

const PORT = process.env.PORT || 9090;

app.use(express.json());
app.use('/api/course-migration', courseMigrationRoutes);
app.use('/api/success-story-migration', successStoryMigrationRoutes);

app.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Course migration service is running.',
    });
});

app.listen(PORT, async () => {
    console.log(`Server Started at Port ${PORT}`.bgGreen);
})
