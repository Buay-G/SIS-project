// ---- Shared i18n for the SIS front-end ----
// One dictionary, reused by the student portal (script.js) and the
// School Hub (hub.js). The chosen language is a deliberate user choice
// (not auto-detected from the browser), stored in localStorage so it
// carries across pages/tabs on this site.
//
// Usage:
//   - Static text: add data-i18n="key" to the element; applyTranslations()
//     sets its textContent on load and whenever the language changes.
//   - Placeholders: data-i18n-placeholder="key"
//   - aria-labels: data-i18n-aria="key"
//   - Dynamic/JS-rendered text (built in template strings): call t('key')
//     or t('key', { name: 'value' }) directly wherever the string is built.

const SIS_LANG_KEY = 'sis_lang';

const SIS_TRANSLATIONS = {
    en: {
        // Nav
        nav_dashboard: 'Dashboard',
        nav_marks: 'My Marks',
        nav_textbooks: 'Textbooks',
        nav_notifications: 'Notifications',
        nav_profile: 'My Profile',
        nav_hub: 'School Hub',
        nav_idcard: 'My ID',
        nav_certificate: 'My Certificate',
        sidebar_open: 'Open navigation menu',

        // Teacher portal nav (extra items not used by the student portal)
        nav_upload_marks: 'Upload Marks',
        nav_view_students: 'View Students',
        nav_reports: 'Reports',
        nav_contact: 'Contact',
        nav_registrar: 'Registrar',
        nav_back_to_site: 'Back to School Website',
        teacher_portal_title: 'Teachers Portal',

        // Top bar
        topbar_notifications: 'Notifications',
        topbar_see_all: 'See all',
        topbar_no_new_notifications: 'No new notifications',
        topbar_help: 'Help and support',
        topbar_profile_settings: '⚙️ Profile Settings',
        topbar_sign_out: 'Sign Out',
        greeting: 'Hi, {name}!',
        greeting_default: 'Hi, Student!',

        loading: 'Loading…',
        could_not_connect: 'Could not connect to server.',

        // Dashboard
        dashboard_heading: 'Dashboard',
        dashboard_quick_summary: 'Quick Summary',
        dashboard_recent_notifications: 'Recent Notifications',
        dashboard_textbook_status: 'Textbook Status',
        dashboard_attendance_streak: 'Attendance Streak',
        dashboard_no_marks: 'No marks recorded yet.',
        dashboard_no_subject_graded: 'No subject fully graded yet',
        dashboard_average: 'Average (completed subjects)',
        dashboard_assessments_recorded: 'Assessments recorded',
        dashboard_subjects: 'Subjects',
        dashboard_no_notifications: 'No notifications.',
        dashboard_could_not_load_attendance: 'Could not load attendance.',
        dashboard_day_streak: 'Day streak',
        dashboard_checked_in_today: 'Checked in today ✅',
        dashboard_not_checked_in: 'Not checked in yet today',

        // Marks
        marks_heading: 'My Marks',
        marks_all_terms: 'All Terms',
        marks_final: 'Final: {pct}%',
        marks_total_so_far: 'Total so far: {pct}% ({have}/{total} assessments)',
        marks_none: 'No marks recorded yet.',
        marks_could_not_load: 'Could not load marks.',
        assessment_individual_assignment_1: 'Assignment 1',
        assessment_individual_assignment_2: 'Assignment 2',
        assessment_group_assignment: 'Group Assignment',
        assessment_quiz: 'Quiz',
        assessment_midterm: 'Midterm',
        assessment_final: 'Final',

        // Textbooks
        textbooks_heading: 'My Textbooks',
        textbooks_desc: 'Textbook distribution status for this school year.',
        textbooks_subject: 'Subject',
        textbooks_status: 'Status',
        textbooks_issued_col: 'Issued',
        textbooks_resolved_col: 'Resolved',
        textbooks_none: 'No textbooks issued this school year.',
        textbooks_could_not_load: 'Could not load textbook status.',
        badge_issued: 'Issued',
        badge_returned: 'Returned',
        badge_lost: 'Lost',

        // Notifications
        notifications_heading: 'Notifications',
        notifications_none: 'No notifications yet.',
        notifications_could_not_load: 'Could not load notifications.',

        // Profile
        profile_heading: 'My Profile',
        profile_identity: 'Identity',
        profile_change_photo: 'Change Profile Photo',
        profile_full_name: 'Full Name:',
        profile_student_id: 'Student ID:',
        profile_sex: 'Sex:',
        profile_status: 'Status:',
        profile_academic_info: 'Academic Info',
        profile_grade: 'Grade:',
        profile_section: 'Section:',
        profile_stream: 'Stream:',
        profile_school: 'School:',
        profile_grade_value: 'Grade {level}',
        profile_id_photo_heading: 'ID Card Photo',
        profile_id_photo_desc: 'Must be portrait, at least 300×360px, roughly a 5:6 width:height ratio — like a passport photo. This is the photo that appears on your ID card, separate from your profile photo above.',
        profile_upload_id_photo: 'Upload ID Photo',
        profile_no_photo: 'No photo uploaded yet',
        profile_account_heading: 'Account',
        profile_lms_username: 'LMS Username:',
        profile_email: 'Email:',
        profile_assigned_pc: 'Assigned PC:',
        profile_security_heading: 'Account Security',
        profile_security_desc: 'If this is your first time logging in, change your password from the default.',
        profile_current_password: 'Current Password',
        profile_new_password: 'New Password',
        profile_confirm_password: 'Confirm New Password',
        profile_update_password: 'Update Password',
        profile_password_updated: 'Password updated successfully.',
        profile_photo_uploaded: 'Uploaded successfully.',
        profile_upload_failed: 'Upload failed.',
        profile_uploading: 'Uploading…',
        profile_fill_all_fields: 'Please fill in all three fields.',
        profile_passwords_no_match: 'New password and confirmation do not match.',
        profile_password_too_short: 'New password must be at least 4 characters.',
        profile_could_not_update_password: 'Could not update password.',

        // ID Card
        idcard_heading: 'My ID Card',
        idcard_desc: 'Present this alongside a physical copy if required by school policy.',
        idcard_flip: 'Flip Card',
        idcard_print: 'Print ID Card',
        idcard_could_not_load: 'Could not load your ID card.',
        idcard_student_id: 'Student ID',
        idcard_class: 'Class',
        idcard_stream: 'Stream',
        idcard_contact: 'Contact',
        idcard_school_code: 'School Code',
        idcard_issued: 'Issued: {date}',
        idcard_valid_until: 'Valid until: {date}',
        idcard_subtitle: 'Student Identity Card',
        idcard_principal: 'Principal',
        idcard_address_not_set: 'Address not set for this school',
        idcard_terms_heading: 'Terms & Conditions',
        idcard_term_property: 'This card is the property of {school} and must be carried at all times on school premises.',
        idcard_term_nontransferable: 'This card is non-transferable. Report loss or theft to the school office immediately.',
        idcard_term_misuse: 'Misuse of this card may result in disciplinary action.',
        idcard_term_validity: 'This card is valid only through the expiry date shown on the front.',
        idcard_return_note: 'If found, please return to the school address below.',

        // Certificate
        certificate_heading: 'My Certificate',
        certificate_term_total: 'Term total: {pct}%',
        certificate_synced: 'Synced',
        certificate_pending_sync: 'Pending sync',
        certificate_not_ready: "Your certificate isn't downloadable yet — every term needs to be fully pushed by your subject teachers and synced by your homeroom teacher to Academic VP first. {count} term(s) still pending.",
        certificate_print_download: 'Print / Download Certificate',
        certificate_none: 'No pushed marks history yet — check back once your teachers have submitted grades.',
        certificate_could_not_load: 'Could not load certificate data.',

        // Help modal
        help_heading: 'Help & Support',
        help_desc: "Send a message to the school's support team. This opens your email app with the message pre-filled.",
        help_subject_placeholder: 'Subject',
        help_body_placeholder: 'Describe your issue...',
        help_cancel: 'Cancel',
        help_send: 'Send',
        help_fill_both: 'Please fill in both the subject and message.',

        // Language switch itself
        lang_switch_label: 'Language',

        // School Hub
        hub_back_to_portal: '← Back to Portal',
        hub_tagline: 'News, photos, and community updates',
        hub_stat_students: 'Students',
        hub_stat_teachers: 'Teachers',
        hub_news_heading: 'News & Announcements',
        hub_gallery_heading: 'School Gallery',
        hub_all_languages: 'All languages',
        hub_lang_english: 'English',
        hub_lang_amharic: 'Amharic',
        hub_lang_nuer: 'Nuer',
        hub_lang_anuak: 'Anuak',
        hub_no_announcements: 'No announcements yet.',
        hub_no_announcements_lang: 'No announcements in this language yet.',
        hub_no_posts: 'No posts yet.',
        hub_no_posts_lang: 'No posts in this language yet.',
        hub_could_not_load_announcements: 'Could not load announcements.',
        hub_could_not_load_gallery: 'Could not load the gallery.',
        hub_posted_by: '— School Administration',
        hub_footer: "Posted by school administration. Visible only to signed-in students, teachers, and staff of this school — no one from another school can see this.",

        // Hub Admin composer
        hub_admin_back: '← Back to Admin Portal',
        hub_admin_tagline: 'Post to the School Hub — students, teachers, and staff at this school will see it immediately.',
        hub_admin_title_label: 'Title',
        hub_admin_body_label: 'Message',
        hub_admin_language_label: 'Language this post is written in',
        hub_admin_post: 'Post Announcement',
        hub_admin_posting: 'Posting…',
        hub_admin_posted: 'Posted.',
        hub_admin_post_failed: 'Could not post. Please try again.',
        hub_admin_fill_title_body: 'Please fill in both the title and message.',
        hub_admin_gallery_text_label: 'Text (optional if you attach a photo)',
        hub_admin_gallery_photo_label: 'Photo (optional if you write text)',
        hub_admin_post_gallery: 'Post to Gallery',
        hub_admin_need_text_or_photo: 'Add some text or attach a photo (or both).',
        hub_admin_existing_posts: 'Existing posts',
        hub_admin_no_posts_yet: 'Nothing posted yet.',
        hub_admin_delete: 'Delete',
        hub_admin_confirm_delete: 'Delete this post? This cannot be undone.',
        hub_admin_deleted: 'Deleted.',
        hub_admin_delete_failed: 'Could not delete. Please try again.',
        hub_admin_could_not_load: 'Could not load existing posts.',
        hub_admin_access_denied: 'This page is for school admin accounts only.',

        // Teacher ID Card (front/back labels not already covered above)
        idcard_teachers_zone: 'Teachers Zone',
        idcard_role_teacher: 'School Teacher',
        idcard_teacher_id: 'Teacher ID',
        idcard_department: 'Department',
        idcard_school_address: 'School Address',
        idcard_email: 'Email',
        idcard_phone: 'Phone',
        idcard_no_photo_alt: 'No photo uploaded',
        idcard_validity_label: 'Validity',
        idcard_contact_info_heading: 'Contact Information',
        idcard_department_default: 'General',

        // Homeroom: reset student password
        homeroom_reset_heading: 'Reset Student Password',
        homeroom_reset_desc: "If a student in your homeroom section forgets their password, reset it here. They can log in with the default password below, then should change it right away from their own Profile page.",
        homeroom_reset_placeholder: 'Student ID',
        homeroom_reset_button: 'Reset Password',
        homeroom_reset_confirm: 'Reset this student\'s password to the default (1234)? They should change it after logging back in.',
        homeroom_reset_confirm_title: 'Reset password?',
        homeroom_reset_success: 'Password reset. The student can now log in with the default password 1234 and should change it from their Profile page.',
        homeroom_reset_enter_id: 'Please enter a student ID.',
        homeroom_reset_failed: 'Could not reset this student\'s password.',
        homeroom_reset_not_in_section: 'This student is not in your homeroom section.',
    },

    am: {
        // Nav
        nav_dashboard: 'ዳሽቦርድ',
        nav_marks: 'የኔ ውጤቶች',
        nav_textbooks: 'የመማሪያ መጻሕፍት',
        nav_notifications: 'ማሳወቂያዎች',
        nav_profile: 'የኔ መገለጫ',
        nav_hub: 'የትምህርት ቤት ማዕከል',
        nav_idcard: 'መታወቂያዬ',
        nav_certificate: 'ምስክር ወረቀቴ',
        sidebar_open: 'የዳሰሳ ምናሌ ክፈት',

        // Teacher portal nav (extra items not used by the student portal)
        nav_upload_marks: 'ውጤት ስቀል',
        nav_view_students: 'ተማሪዎችን ይመልከቱ',
        nav_reports: 'ሪፖርቶች',
        nav_contact: 'ያግኙን',
        nav_registrar: 'መዝጋቢ',
        nav_back_to_site: 'ወደ ትምህርት ቤት ድረ-ገጽ ተመለስ',
        teacher_portal_title: 'የመምህራን መግቢያ ገጽ',

        // Top bar
        topbar_notifications: 'ማሳወቂያዎች',
        topbar_see_all: 'ሁሉንም ይመልከቱ',
        topbar_no_new_notifications: 'አዲስ ማሳወቂያ የለም',
        topbar_help: 'እርዳታ እና ድጋፍ',
        topbar_profile_settings: '⚙️ የመገለጫ ቅንብሮች',
        topbar_sign_out: 'ውጣ',
        greeting: 'ሰላም, {name}!',
        greeting_default: 'ሰላም, ተማሪ!',

        loading: 'በመጫን ላይ...',
        could_not_connect: 'ከአገልጋይ ጋር መገናኘት አልተቻለም።',

        // Dashboard
        dashboard_heading: 'ዳሽቦርድ',
        dashboard_quick_summary: 'አጭር ማጠቃለያ',
        dashboard_recent_notifications: 'የቅርብ ጊዜ ማሳወቂያዎች',
        dashboard_textbook_status: 'የመጽሐፍ ሁኔታ',
        dashboard_attendance_streak: 'የመገኘት ተከታታይነት',
        dashboard_no_marks: 'እስካሁን ውጤት አልተመዘገበም።',
        dashboard_no_subject_graded: 'እስካሁን ሙሉ በሙሉ ውጤት ያገኘ ትምህርት የለም',
        dashboard_average: 'አማካይ (የተጠናቀቁ ትምህርቶች)',
        dashboard_assessments_recorded: 'የተመዘገቡ ምዘናዎች',
        dashboard_subjects: 'ትምህርቶች',
        dashboard_no_notifications: 'ማሳወቂያ የለም።',
        dashboard_could_not_load_attendance: 'የመገኘት መረጃ መጫን አልተቻለም።',
        dashboard_day_streak: 'ተከታታይ ቀናት',
        dashboard_checked_in_today: 'ዛሬ ገብተዋል ✅',
        dashboard_not_checked_in: 'ዛሬ ገና አልገቡም',

        // Marks
        marks_heading: 'የኔ ውጤቶች',
        marks_all_terms: 'ሁሉም ወቅቶች',
        marks_final: 'ውጤት: {pct}%',
        marks_total_so_far: 'እስካሁን ድምር: {pct}% ({have}/{total} ምዘናዎች)',
        marks_none: 'እስካሁን ውጤት አልተመዘገበም።',
        marks_could_not_load: 'ውጤቶችን መጫን አልተቻለም።',
        assessment_individual_assignment_1: 'ስራ 1',
        assessment_individual_assignment_2: 'ስራ 2',
        assessment_group_assignment: 'የቡድን ስራ',
        assessment_quiz: 'አጭር ፈተና',
        assessment_midterm: 'የመንፈቀ ዓመት ፈተና',
        assessment_final: 'የመጨረሻ ፈተና',

        // Textbooks
        textbooks_heading: 'የኔ የመማሪያ መጻሕፍት',
        textbooks_desc: 'ለዚህ የትምህርት ዘመን የመጻሕፍት ስርጭት ሁኔታ።',
        textbooks_subject: 'ትምህርት',
        textbooks_status: 'ሁኔታ',
        textbooks_issued_col: 'የተሰጠበት ቀን',
        textbooks_resolved_col: 'የተወሰነበት ቀን',
        textbooks_none: 'በዚህ የትምህርት ዘመን የተሰጠ መጽሐፍ የለም።',
        textbooks_could_not_load: 'የመጽሐፍ ሁኔታን መጫን አልተቻለም።',
        badge_issued: 'ተሰጥቷል',
        badge_returned: 'ተመልሷል',
        badge_lost: 'ጠፍቷል',

        // Notifications
        notifications_heading: 'ማሳወቂያዎች',
        notifications_none: 'እስካሁን ማሳወቂያ የለም።',
        notifications_could_not_load: 'ማሳወቂያዎችን መጫን አልተቻለም።',

        // Profile
        profile_heading: 'የኔ መገለጫ',
        profile_identity: 'ማንነት',
        profile_change_photo: 'የመገለጫ ፎቶ ቀይር',
        profile_full_name: 'ሙሉ ስም:',
        profile_student_id: 'የተማሪ መታወቂያ:',
        profile_sex: 'ጾታ:',
        profile_status: 'ሁኔታ:',
        profile_academic_info: 'የትምህርት መረጃ',
        profile_grade: 'ክፍል:',
        profile_section: 'ንዑስ ክፍል:',
        profile_stream: 'ትምህርት ዘርፍ:',
        profile_school: 'ትምህርት ቤት:',
        profile_grade_value: 'ክፍል {level}',
        profile_id_photo_heading: 'የመታወቂያ ፎቶ',
        profile_id_photo_desc: 'ፎቶው ቀጥ ያለ (ፖርትሬት)፣ ቢያንስ 300×360 ፒክሰል፣ በግምት 5:6 ስፋት:ቁመት መጠን ያለው — እንደ ፓስፖርት ፎቶ መሆን አለበት። ይህ ከላይ ካለው የመገለጫ ፎቶዎ ተለይቶ በመታወቂያ ካርድዎ ላይ የሚታየው ፎቶ ነው።',
        profile_upload_id_photo: 'የመታወቂያ ፎቶ ስቀል',
        profile_no_photo: 'እስካሁን ፎቶ አልተሰቀለም',
        profile_account_heading: 'መለያ',
        profile_lms_username: 'የኤልኤምኤስ የተጠቃሚ ስም:',
        profile_email: 'ኢሜይል:',
        profile_assigned_pc: 'የተመደበ ኮምፒውተር:',
        profile_security_heading: 'የመለያ ደህንነት',
        profile_security_desc: 'ይህ የመጀመሪያ መግቢያዎ ከሆነ፣ የይለፍ ቃልዎን ከነባሪው ይቀይሩ።',
        profile_current_password: 'የአሁኑ የይለፍ ቃል',
        profile_new_password: 'አዲስ የይለፍ ቃል',
        profile_confirm_password: 'አዲሱን የይለፍ ቃል ያረጋግጡ',
        profile_update_password: 'የይለፍ ቃል አዘምን',
        profile_password_updated: 'የይለፍ ቃል በተሳካ ሁኔታ ተቀይሯል።',
        profile_photo_uploaded: 'በተሳካ ሁኔታ ተሰቅሏል።',
        profile_upload_failed: 'መስቀል አልተቻለም።',
        profile_uploading: 'በመስቀል ላይ...',
        profile_fill_all_fields: 'እባክዎ ሁሉንም ሶስት መስኮች ይሙሉ።',
        profile_passwords_no_match: 'አዲሱ የይለፍ ቃል እና ማረጋገጫው አይመሳሰሉም።',
        profile_password_too_short: 'አዲሱ የይለፍ ቃል ቢያንስ 4 ፊደላት ሊኖረው ይገባል።',
        profile_could_not_update_password: 'የይለፍ ቃል ማዘመን አልተቻለም።',

        // ID Card
        idcard_heading: 'የመታወቂያ ካርዴ',
        idcard_desc: 'ትምህርት ቤቱ የሚጠይቅ ከሆነ ከአካላዊ ቅጂ ጋር ይህን ያቅርቡ።',
        idcard_flip: 'ካርዱን ገልብጥ',
        idcard_print: 'መታወቂያ ካርድ አትም',
        idcard_could_not_load: 'የመታወቂያ ካርድዎን መጫን አልተቻለም።',
        idcard_student_id: 'የተማሪ መታወቂያ',
        idcard_class: 'ክፍል',
        idcard_stream: 'ትምህርት ዘርፍ',
        idcard_contact: 'ስልክ ቁጥር',
        idcard_school_code: 'የትምህርት ቤት ኮድ',
        idcard_issued: 'የተሰጠበት: {date}',
        idcard_valid_until: 'የሚያገለግልበት እስከ: {date}',
        idcard_subtitle: 'የተማሪ መታወቂያ ካርድ',
        idcard_principal: 'ርዕሰ መምህር',
        idcard_address_not_set: 'ለዚህ ትምህርት ቤት አድራሻ አልተመዘገበም',
        idcard_terms_heading: 'ደንቦች እና ሁኔታዎች',
        idcard_term_property: 'ይህ ካርድ የ{school} ንብረት ሲሆን በትምህርት ቤት ቅጥር ግቢ ውስጥ ሁልጊዜ ተይዞ መቆየት አለበት።',
        idcard_term_nontransferable: 'ይህ ካርድ ለሌላ ሰው ሊተላለፍ አይችልም። መጥፋት ወይም መሰረቅ ካጋጠመ ወዲያውኑ ለትምህርት ቤቱ ጽ/ቤት ያሳውቁ።',
        idcard_term_misuse: 'ይህን ካርድ አላግባብ መጠቀም የዲሲፕሊን እርምጃ ሊያስከትል ይችላል።',
        idcard_term_validity: 'ይህ ካርድ በፊት ገጹ ላይ በተመለከተው የማብቂያ ቀን ብቻ የሚያገለግል ነው።',
        idcard_return_note: 'ካገኙት፣ እባክዎ ከታች ወዳለው የትምህርት ቤቱ አድራሻ ይመልሱት።',

        // Certificate
        certificate_heading: 'ምስክር ወረቀቴ',
        certificate_term_total: 'የወቅት ድምር: {pct}%',
        certificate_synced: 'ተመሳስሏል',
        certificate_pending_sync: 'ማመሳሰል በመጠባበቅ ላይ',
        certificate_not_ready: 'ምስክር ወረቀትዎ ገና ለማውረድ ዝግጁ አይደለም — እያንዳንዱ ወቅት በመምህራንዎ ሙሉ በሙሉ መተላለፍ እና በክፍል መምህርዎ ወደ አካዳሚክ ምክትል ርዕሰ መምህር መመሳሰል አለበት። {count} ወቅት(ት) አሁንም በመጠባበቅ ላይ ናቸው።',
        certificate_print_download: 'ምስክር ወረቀት አትም / አውርድ',
        certificate_none: 'እስካሁን የተላለፈ ውጤት ታሪክ የለም — መምህራንዎ ውጤት እስኪያስገቡ ድረስ እባክዎ ቆይተው ይመልከቱ።',
        certificate_could_not_load: 'የምስክር ወረቀት መረጃ መጫን አልተቻለም።',

        // Help modal
        help_heading: 'እርዳታ እና ድጋፍ',
        help_desc: 'ለትምህርት ቤቱ የድጋፍ ቡድን መልእክት ይላኩ። ይህ የኢሜይል መተግበሪያዎን በተሞላ መልእክት ይከፍታል።',
        help_subject_placeholder: 'ርዕሰ ጉዳይ',
        help_body_placeholder: 'ችግርዎን ይግለጹ...',
        help_cancel: 'ሰርዝ',
        help_send: 'ላክ',
        help_fill_both: 'እባክዎ ርዕሰ ጉዳይ እና መልእክት ሁለቱንም ይሙሉ።',

        // Language switch itself
        lang_switch_label: 'ቋንቋ',

        // School Hub
        hub_back_to_portal: '← ወደ መግቢያ ገጽ ተመለስ',
        hub_tagline: 'ዜናዎች፣ ፎቶዎች እና የማህበረሰብ ዝማኔዎች',
        hub_stat_students: 'ተማሪዎች',
        hub_stat_teachers: 'መምህራን',
        hub_news_heading: 'ዜናዎች እና ማስታወቂያዎች',
        hub_gallery_heading: 'የትምህርት ቤት ፎቶ ማዕከል',
        hub_all_languages: 'ሁሉም ቋንቋዎች',
        hub_lang_english: 'እንግሊዝኛ',
        hub_lang_amharic: 'አማርኛ',
        hub_lang_nuer: 'ኑዌር',
        hub_lang_anuak: 'አኙዋክ',
        hub_no_announcements: 'እስካሁን ማስታወቂያ የለም።',
        hub_no_announcements_lang: 'በዚህ ቋንቋ እስካሁን ማስታወቂያ የለም።',
        hub_no_posts: 'እስካሁን ልጥፍ የለም።',
        hub_no_posts_lang: 'በዚህ ቋንቋ እስካሁን ልጥፍ የለም።',
        hub_could_not_load_announcements: 'ማስታወቂያዎችን መጫን አልተቻለም።',
        hub_could_not_load_gallery: 'የፎቶ ማዕከሉን መጫን አልተቻለም።',
        hub_posted_by: '— የትምህርት ቤት አስተዳደር',
        hub_footer: 'በትምህርት ቤት አስተዳደር የተለጠፈ። ለዚህ ትምህርት ቤት ብቻ ለገቡ ተማሪዎች፣ መምህራን እና ሰራተኞች ይታያል — ከሌላ ትምህርት ቤት ማንም ሊያየው አይችልም።',

        // Hub Admin composer
        hub_admin_back: '← ወደ አስተዳደር ገጽ ተመለስ',
        hub_admin_tagline: 'ወደ ትምህርት ቤት ማዕከል ይለጥፉ — በዚህ ትምህርት ቤት ያሉ ተማሪዎች፣ መምህራን እና ሰራተኞች ወዲያውኑ ያዩታል።',
        hub_admin_title_label: 'ርዕስ',
        hub_admin_body_label: 'መልእክት',
        hub_admin_language_label: 'ይህ ልጥፍ የተጻፈበት ቋንቋ',
        hub_admin_post: 'ማስታወቂያ ለጥፍ',
        hub_admin_posting: 'በመለጠፍ ላይ...',
        hub_admin_posted: 'ተለጥፏል።',
        hub_admin_post_failed: 'መለጠፍ አልተቻለም። እባክዎ እንደገና ይሞክሩ።',
        hub_admin_fill_title_body: 'እባክዎ ርዕሱን እና መልእክቱን ሁለቱንም ይሙሉ።',
        hub_admin_gallery_text_label: 'ጽሑፍ (ፎቶ ካያያዙ አማራጭ ነው)',
        hub_admin_gallery_photo_label: 'ፎቶ (ጽሑፍ ከጻፉ አማራጭ ነው)',
        hub_admin_post_gallery: 'ወደ ፎቶ ማዕከል ለጥፍ',
        hub_admin_need_text_or_photo: 'ጽሑፍ ይጨምሩ ወይም ፎቶ ያያይዙ (ወይም ሁለቱንም)።',
        hub_admin_existing_posts: 'ነባር ልጥፎች',
        hub_admin_no_posts_yet: 'እስካሁን የተለጠፈ ነገር የለም።',
        hub_admin_delete: 'ሰርዝ',
        hub_admin_confirm_delete: 'ይህን ልጥፍ ይሰርዙ? ይህ ተመልሶ ሊቀለበስ አይችልም።',
        hub_admin_deleted: 'ተሰርዟል።',
        hub_admin_delete_failed: 'መሰረዝ አልተቻለም። እባክዎ እንደገና ይሞክሩ።',
        hub_admin_could_not_load: 'ነባር ልጥፎችን መጫን አልተቻለም።',
        hub_admin_access_denied: 'ይህ ገጽ ለትምህርት ቤት አስተዳደር መለያዎች ብቻ ነው።',

        // Teacher ID Card (front/back labels not already covered above)
        idcard_teachers_zone: 'የመምህራን ዞን',
        idcard_role_teacher: 'የትምህርት ቤት መምህር',
        idcard_teacher_id: 'የመምህር መታወቂያ',
        idcard_department: 'ክፍል',
        idcard_school_address: 'የትምህርት ቤት አድራሻ',
        idcard_email: 'ኢሜይል',
        idcard_phone: 'ስልክ',
        idcard_no_photo_alt: 'ፎቶ አልተሰቀለም',
        idcard_validity_label: ' የሚያገለግልበት',
        idcard_contact_info_heading: 'የመገኛ አድራሻ መረጃ',
        idcard_department_default: 'አጠቃላይ',

        // Homeroom: reset student password
        homeroom_reset_heading: 'የተማሪ የይለፍ ቃል ዳግም አስጀምር',
        homeroom_reset_desc: 'በክፍልዎ ውስጥ ያለ ተማሪ የይለፍ ቃሉን ከረሳ፣ እዚህ ዳግም ያስጀምሩለት። ከዚያ በኋላ ከታች በተጠቀሰው ነባሪ የይለፍ ቃል መግባት ይችላል፣ እና ወዲያውኑ ከመገለጫ ገጹ ሊቀይረው ይገባል።',
        homeroom_reset_placeholder: 'የተማሪ መታወቂያ',
        homeroom_reset_button: 'የይለፍ ቃል ዳግም አስጀምር',
        homeroom_reset_confirm: 'የዚህ ተማሪ የይለፍ ቃል ወደ ነባሪው (1234) ዳግም ይጀመር? ተማሪው ከገባ በኋላ መቀየር አለበት።',
        homeroom_reset_confirm_title: 'የይለፍ ቃል ዳግም ይጀመር?',
        homeroom_reset_success: 'የይለፍ ቃል ዳግም ተጀምሯል። ተማሪው አሁን በነባሪው የይለፍ ቃል 1234 መግባት ይችላል፣ እና ከመገለጫ ገጹ ሊቀይረው ይገባል።',
        homeroom_reset_enter_id: 'እባክዎ የተማሪ መታወቂያ ያስገቡ።',
        homeroom_reset_failed: 'የዚህን ተማሪ የይለፍ ቃል ዳግም ማስጀመር አልተቻለም።',
        homeroom_reset_not_in_section: 'ይህ ተማሪ በእርስዎ የክፍል ክፍል ውስጥ አይደለም።',
    }
};

function getCurrentLang() {
    const stored = localStorage.getItem(SIS_LANG_KEY);
    return stored === 'am' ? 'am' : 'en';
}

// t('key') or t('key', { name: 'Abebe' }) for strings with {placeholders}.
// Falls back to English, then to the raw key, so a missing translation
// never renders as a blank string.
function t(key, params) {
    const lang = getCurrentLang();
    let str = (SIS_TRANSLATIONS[lang] && SIS_TRANSLATIONS[lang][key])
        || (SIS_TRANSLATIONS.en && SIS_TRANSLATIONS.en[key])
        || key;
    if (params) {
        Object.keys(params).forEach(p => {
            str = str.replace(new RegExp(`\\{${p}\\}`, 'g'), params[p]);
        });
    }
    return str;
}

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
        el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
    document.documentElement.setAttribute('lang', getCurrentLang());
    document.querySelectorAll('.lang-switch-btn').forEach(btn => {
        const active = btn.dataset.lang === getCurrentLang();
        btn.classList.toggle('lang-switch-active', active);
        if (btn.hasAttribute('aria-selected')) btn.setAttribute('aria-selected', String(active));
    });
}

// setLang is exposed globally so pages just wire onclick="setLang('am')".
// window.onSisLangChange (optional, set by the page) lets script.js/hub.js
// re-run their own dynamic renders after a language switch, since those
// build HTML with t() at fetch time rather than data-i18n attributes.
window.setLang = (lang) => {
    localStorage.setItem(SIS_LANG_KEY, lang === 'am' ? 'am' : 'en');
    applyTranslations();
    if (typeof window.onSisLangChange === 'function') window.onSisLangChange();
};

document.addEventListener('DOMContentLoaded', applyTranslations);