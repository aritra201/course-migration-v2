export default function (sequelize, DataTypes) {
    return sequelize.define(
        "courses",
        {
            id: {
                autoIncrement: true,
                type: DataTypes.INTEGER,
                allowNull: false,
                primaryKey: true
            },
            old_course_id: {
                type: DataTypes.INTEGER,
                allowNull: true
            },

            title: {
                type: DataTypes.STRING(255),
                allowNull: false
            },

            url_masking: {
                type: DataTypes.STRING(255),
                allowNull: false,
                unique: true
            },

            slug: {
                type: DataTypes.STRING(255),
                allowNull: false,
                unique: true
            },

            course_content: {
                type: DataTypes.TEXT,
                allowNull: true
            },

            duration_minutes: {
                type: DataTypes.STRING(50),
                allowNull: true
            },

            class_routine: {
                type:DataTypes.STRING(50),
                allowNull: true
            },

            is_published: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false
            },

            status : {
                type: DataTypes.ENUM("A", "P", "D"),  // A: Active, P: Pending, D: Deleted
                allowNull: false,
                defaultValue: "A"
            },

            enrollment_last_date: {
                type: DataTypes.DATE,
                allowNull: true
            },

            payment_enabled: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true
            },

            currency: {
                type: DataTypes.STRING(10),
                allowNull: false,
                defaultValue: "USD"
            },

            amount: {
                type: DataTypes.DECIMAL(12, 2),
                allowNull: false,
                defaultValue: 0
            },

            third_party_lead_enabled: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false
            },

            course_category: {
                type: DataTypes.INTEGER,
                allowNull: true,
                references: {
                    model: "course_categories",
                    key: "id"
                }
            },
            course_type_id: {
                type: DataTypes.INTEGER,
                allowNull: true,
                references: {
                    model: "course_types",
                    key: "id"
                }
            },
            ap_portal_course_catagory_id: {
                type: DataTypes.INTEGER,
                allowNull: true
            },
            ap_portal_course_id: {
                type: DataTypes.INTEGER,
                allowNull: true
            },
            additional_price: {
                type: DataTypes.DECIMAL(12, 2),
                allowNull: true,
                defaultValue: null
            },
            banner_url: {
                type: DataTypes.STRING(500),
                allowNull: true,
                comment: 'S3 URL for course banner image'
            },

            share_enabled: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true
            },
            is_new: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true
            },
            is_featured: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true
            },
            short_description: {
                type: DataTypes.TEXT,
                allowNull: true
            },
            get_study_material_enabled: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false
            },
            study_material_email_template: {
                type: DataTypes.TEXT,
                allowNull: true
            },
            counselling_call_enabled: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false
            },
            join_waitlist_enabled: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false
            },
            join_waitlist_email_template: {
                type: DataTypes.TEXT,
                allowNull: true
            },
            use_custom_study_material_template: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false
            },
            use_custom_join_waitlist_email_template: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false
            },
            banner_phone: {
                type: DataTypes.STRING(255),
                allowNull: true
            },
            show_banner_phone: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true
            },
            use_google_tag: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false
            },
            send_to_timepay: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false
            },
            banner_tag_line: {
                type: DataTypes.STRING(255),
                allowNull: true
            },

            show_banner_tagline: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true
            },
            
            show_learn_from: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false
            },
            learn_from: {
                type: DataTypes.STRING(255),
                allowNull: true
            },
            show_get_course_syllabus: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true
            },
            get_course_syllabus_link: {
                type: DataTypes.STRING(500),
                allowNull: true
            },
            refund_policy: {
                type: DataTypes.BOOLEAN,
                allowNull: true,
                defaultValue: false
            },
            logo_type: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
            location_short_name: {
                type: DataTypes.STRING(10),
                allowNull: false,
                defaultValue: 'IN',
            },
            hide_from_list: {
                type: DataTypes.ENUM('Y', 'N'),
                allowNull: false,
                defaultValue: 'N',
            },
            hide_last_enrollment_date: {
                type: DataTypes.STRING(1),
                allowNull: false,
                defaultValue: "N"
            },
            payment_gateway: {
                type: DataTypes.STRING(50),
                allowNull: true,
                defaultValue: null
            },
            edmingle_course_id: {
                type: DataTypes.INTEGER,
                allowNull: true,
                defaultValue: null
            },
        },
        {
            sequelize,
            tableName: "courses",
            timestamps: true,
            indexes: [
                { name: "courses_pkey", unique: true, fields: ["id"] },
                { name: "courses_slug_unique", unique: true, fields: ["slug"] },
                { name: "idx_courses_is_published", fields: ["is_published"] },
                { name: "idx_courses_course_category", fields: ["course_category"] },
                { name: "idx_courses_course_type_id", fields: ["course_type_id"] },
                { name: "idx_courses_ap_portal_course_catagory_id", fields: ["ap_portal_course_catagory_id"] },
                { name: "idx_courses_ap_portal_course_id", fields: ["ap_portal_course_id"] }
            ]
        }
    );
}