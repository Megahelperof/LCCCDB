const admin = require('firebase-admin');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { parse } = require('date-fns');
const { v4: uuidv4 } = require('uuid');
 ;


const app = express();
const port = process.env.PORT || 3001;


// Firebase Admin SDK initialization
const serviceAccount = require('./lcccdb-891ca-firebase-adminsdk-h9lxo-5708b4b4b1.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "lcccdb-891ca.appspot.com"
});

const db = admin.firestore();
const bucket = admin.storage().bucket();
const dataFilePath = path.join(__dirname, 'studentData.json');

// Middleware to parse JSON bodies
app.use(express.json());

// Global variables to store late time settings
let startTime = '04:10';
let lateTime = '07:10';

function getPhilippineTime() {
  return new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' });
}

function parseDateTime(dateTimeString) {
  // Remove "(Late)" or any other parenthetical information
  dateTimeString = dateTimeString.replace(/\s*\([^)]*\)/, '').trim();

  // Split the string into date and time parts
  const [datePart, timePart] = dateTimeString.split(', Time: ');

  if (!datePart || !timePart) {
    console.error(`Invalid date-time format: ${dateTimeString}`);
    return null;
  }

  const [year, month, day] = datePart.split('-').map(Number);
  
  // Split the time part and remove any empty strings
  const timeParts = timePart.split('_').filter(Boolean);

  if (timeParts.length < 4) {
    console.error(`Invalid time format: ${timePart}`);
    return null;
  }

  const [hourMinSec, period] = timeParts.slice(-2);

  if (!hourMinSec || !period) {
    console.error(`Invalid time format: ${timePart}`);
    return null;
  }

  const [hours, minutes, seconds] = hourMinSec.split(':').map(Number);

  // Adjust hours for PM
  const adjustedHours = period.toUpperCase() === 'PM' && hours !== 12 ? hours + 12 : hours;

  // Check if the parsed values are valid
  if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hours) || isNaN(minutes) || isNaN(seconds)) {
    console.error(`Invalid date components: ${dateTimeString}`);
    return null;
  }
  
  const date = new Date(year, month - 1, day, adjustedHours, minutes, seconds);
  
  // Check if the resulting date is valid
  if (isNaN(date.getTime())) {
    console.error(`Invalid date created from string: ${dateTimeString}`);
    return null;
  }
  
  return date;
}


async function getLastActivity(studentNumber, date) {
  const studentDocRef = db.collection('students').doc(studentNumber);
  const studentDoc = await studentDocRef.get();
  const studentData = studentDoc.exists ? studentDoc.data() : null;

  if (studentData) {
    const entryTimes = studentData.entryTime || [];
    const exitTimes = studentData.exitTime || [];

    // Find the last activity on the given date
    for (let i = entryTimes.length - 1; i >= 0; i--) {
      if (dateMatches(entryTimes[i], date)) {
        return { time: entryTimes[i], type: 'entry' };
      }
    }

    for (let i = exitTimes.length - 1; i >= 0; i--) {
      if (dateMatches(exitTimes[i], date)) {
        return { time: exitTimes[i], type: 'exit' };
      }
    }
  }

  return null;
}

function dateMatches(dateTimeString, targetDate) {
  const parsedDate = parseDateTime(dateTimeString);
  if (parsedDate === null) {
    return false; // or handle the error as appropriate for your application
  }
  return parsedDate.toISOString().split('T')[0] === targetDate;
}

function isLate(entryTime) {
  const time = new Date(entryTime);
  const { hours: startHours, minutes: startMinutes } = parseTime(startTime);
  const { hours: lateHours, minutes: lateMinutes } = parseTime(lateTime);

  const startThreshold = new Date(time);
  startThreshold.setHours(startHours, startMinutes, 0, 0);

  const lateThreshold = new Date(time);
  lateThreshold.setHours(lateHours, lateMinutes, 0, 0);

  return time < startThreshold || time > lateThreshold;
}

// Helper function to get the folder path for a student
function getStudentFolderPath(grade, section, studentNumber) {
  return `students/${grade}/${section}/${studentNumber}/`;
}

// Updated logStudentActivity function

async function logStudentActivity(studentNumber, fullName, logViolations = false) {
  const activityTime = getPhilippineTime();
  const formattedActivityTime = activityTime.replace(/[^\w\s]/gi, '_');
  const date = new Date(activityTime).toISOString().split('T')[0];

  // Find the correct folder path based on the student's grade and section
  let folderPath = null;
  let grade = null;
  let section = null;

  // Check for the main.txt file in all possible folders
  const possibleFolders = [
    `students/7/A/${studentNumber}/`,
    `students/7/B/${studentNumber}/`,
    `students/7/C/${studentNumber}/`,
    `students/7/D/${studentNumber}/`,
    `students/8/A/${studentNumber}/`,
    `students/8/B/${studentNumber}/`,
    `students/8/C/${studentNumber}/`,
    `students/8/D/${studentNumber}/`,
    `students/9/A/${studentNumber}/`,
    `students/9/B/${studentNumber}/`,
    `students/9/C/${studentNumber}/`,
    `students/9/D/${studentNumber}/`,
    `students/10/A/${studentNumber}/`,
    `students/10/B/${studentNumber}/`,
    `students/10/C/${studentNumber}/`,
    `students/10/D/${studentNumber}/`,
  ];

  for (const folder of possibleFolders) {
    const mainFilePath = `${folder}${studentNumber}_main.txt`;
    const [mainFileExists] = await bucket.file(mainFilePath).exists();

    if (mainFileExists) {
      folderPath = folder;
      // Read the student's grade and section from the main file
      const [content] = await bucket.file(mainFilePath).download();
      const fileContent = content.toString('utf-8');
      const lines = fileContent.split('\n');

      for (const line of lines) {
        if (line.startsWith('Grade:')) {
          grade = line.split(':')[1].trim();
        } else if (line.startsWith('Section:')) {
          section = line.split(':')[1].trim();
        }
      }
      console.log(`Main folder found at: ${folderPath}`);
      break;
    }
  }

  

  if (!folderPath) {
    console.error(`Main folder not found for student ${studentNumber}`);
    return { isExit: false, activityLabel: null };
  }

  const logFilePath = `${folderPath}${studentNumber}_activity.txt`;

  try {
    let isExit = false;
    let lateTag = '';
    let violationsTag = '';

    // Check for last activity
    const lastActivity = await getLastActivity(studentNumber, date);
    if (lastActivity) {
      const lastActivityTime = new Date(lastActivity.time);
      const currentTime = new Date(activityTime);
      const timeDiff = (currentTime - lastActivityTime) / (1000 * 60); // difference in minutes
      const lastActivityDate = lastActivityTime.toISOString().split('T')[0];

      if (lastActivityDate === date) {
        if (lastActivity.type === 'entry' && timeDiff >= 1) {
          isExit = true;
        } else if (timeDiff < 1) {
          console.log(`Cooldown period not met for ${fullName} (${studentNumber}). Skipping log.`);
          return { isExit: false, activityLabel: null };
        }
      }
    }

    if (!isExit) {
      lateTag = isLate(activityTime) ? ' (Late)' : '';
    }

    if (logViolations) {
      violationsTag = ' (Violations)';
    }

    // Update Firestore
    const activityType = isExit ? 'exitTime' : 'entryTime';
    const studentDocRef = db.collection('students').doc(studentNumber);
    const studentDoc = await studentDocRef.get();
    const studentData = studentDoc.exists ? studentDoc.data() : null;

    if (studentData) {
      await studentDocRef.update({
        [activityType]: admin.firestore.FieldValue.arrayUnion(`${formattedActivityTime}${lateTag}${violationsTag}`),
        lastActivity: { time: activityTime, type: isExit ? 'exit' : 'entry' },
        grade: grade,
        section: section
      });
    } else {
      await studentDocRef.set({
        studentNumber: studentNumber,
        fullName: fullName,
        grade: grade,
        section: section,
        [activityType]: [`${formattedActivityTime}${lateTag}${violationsTag}`],
        lastActivity: { time: activityTime, type: 'entry' }
      });
    }

    // Update activity file in Firebase Storage
    const activityLabel = isExit ? 'Exit' : 'Entry';
    const activityFileContent = `${activityLabel} Date: ${date}, Time: ${formattedActivityTime}${lateTag}${violationsTag}\n`;
    await appendToFirebaseFile(logFilePath, activityFileContent);

    console.log(`Logged ${activityLabel.toLowerCase()} for ${fullName} (${studentNumber}) at ${formattedActivityTime}${lateTag}${violationsTag}`);
    return { isExit, activityLabel, grade, section };
  } catch (error) {
    console.error(`Error in logStudentActivity:`, error);
    throw error;
  }
}
// Updated logStudentActivity function


async function appendToFirebaseFile(filePath, content) {
  try {
    const file = bucket.file(filePath);
    const [exists] = await file.exists();

    if (!exists) {
      await file.save(content);
    } else {
      const [currentContent] = await file.download();
      const updatedContent = currentContent.toString() + content;
      await file.save(updatedContent);
    }

    console.log(`Updated file: ${filePath}`);
  } catch (error) {
    console.error(`Error appending to Firebase file ${filePath}:`, error);
    throw error;
  }
}

async function updateMainTxtWithLateEntries(studentNumber, grade, section, newEntry) {
  const folderPath = getStudentFolderPath(grade, section, studentNumber);
  const filePath = `${folderPath}${studentNumber}_main.txt`;

  try {
    // Read existing content
    const [fileExists] = await bucket.file(filePath).exists();
    let content = '';
    if (fileExists) {
      const [fileContent] = await bucket.file(filePath).download();
      content = fileContent.toString('utf-8');
    }

    // Parse existing content
    const lines = content.split('\n');
    const headerLines = lines.slice(0, 4); // Assuming the first 4 lines are header information
    let lateEntries = lines.slice(4).filter(line => line.trim() !== '');

    // Add new entry if it's late
    if (newEntry.includes('(Late)')) {
      lateEntries.push(newEntry);
    }

    // Sort late entries by date
    lateEntries.sort((a, b) => {
      const dateA = new Date(a.split(', Time:')[0].split('Date: ')[1]);
      const dateB = new Date(b.split(', Time:')[0].split('Date: ')[1]);
      return dateB - dateA;
    });

    // Combine header and sorted late entries
    const updatedContent = [...headerLines, ...lateEntries].join('\n');

    // Upload updated content
    await bucket.file(filePath).save(updatedContent, {
      contentType: 'text/plain',
      metadata: {
        cacheControl: 'private, max-age=0'
      }
    });

    console.log(`Updated main.txt for student ${studentNumber} with late entries`);
  } catch (error) {
    console.error(`Error updating main.txt for student ${studentNumber}:`, error);
  }
}

// New endpoint to set late times
app.post('/setLateTimes', (req, res) => {
  const { newStartTime, newLateTime } = req.body;

  if (!newStartTime || !newLateTime) {
    return res.status(400).json({ success: false, message: 'Both start time and late time are required.' });
  }

  // Validate time format (HH:MM)
  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!timeRegex.test(newStartTime) || !timeRegex.test(newLateTime)) {
    return res.status(400).json({ success: false, message: 'Invalid time format. Use HH:MM.' });
  }

  startTime = newStartTime;
  lateTime = newLateTime;

  res.json({
    success: true,
    message: 'Late times updated successfully.',
    startTime: startTime,
    lateTime: lateTime
  });
});

app.post('/logActivity', async (req, res) => {
  const { studentNumber } = req.body;

  if (!studentNumber) {
    return res.status(400).json({ success: false, message: 'Student number is required.' });
  }

  try {
    const studentDocRef = db.collection('students').doc(studentNumber);
    const studentDoc = await studentDocRef.get();

    if (!studentDoc.exists) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    const studentData = studentDoc.data();
    const { isExit, activityLabel } = await logStudentActivity(studentNumber, studentData.fullName, studentData.grade, studentData.section);

    res.json({
      success: true,
      fullName: studentData.fullName,
      message: `${activityLabel} logged successfully.`,
      isExit: isExit
    });
  } catch (error) {
    console.error('Error logging activity:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error. Please try again later.'
    });
  }
});

app.post('/logEntrance', async (req, res) => {
  const { studentNumber, violations } = req.body;

  if (!studentNumber) {
    return res.status(400).json({ success: false, message: 'Student number is required.' });
  }

  try {
    const studentDocRef = db.collection('students').doc(studentNumber);
    const studentDoc = await studentDocRef.get();

    if (!studentDoc.exists) {
      return res.status(404).json({ success: false, message: 'Student not found.' });
    }

    const studentData = studentDoc.data();
    const { isExit, activityLabel } = await logStudentActivity(studentNumber, studentData.fullName, !!violations);

    let message = `${activityLabel} logged successfully.`;
    if (violations) {
      message += ' Violations recorded.';
    }

    res.json({
      success: true,
      fullName: studentData.fullName,
      message: message,
      isExit: isExit
    });
  } catch (error) {
    console.error('Error logging entrance:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error. Please try again later.'
    });
  }
});
app.get('/search', async (req, res) => {
  const studentNumber = req.query.studentNumber;

  if (!studentNumber) {
    return res.status(400).json({ error: 'Student number is required' });
  }

  try {
    const studentDocRef = db.collection('students').doc(studentNumber);
    const studentDoc = await studentDocRef.get();

    if (studentDoc.exists) {
      const studentData = studentDoc.data();
      res.json({ fullName: studentData.fullName });
    } else {
      res.json({ error: 'Student not found' });
    }
  } catch (error) {
    console.error('Error fetching student data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/validate-token', async (req, res) => {
  const { token } = req.body;

  if (!token || token.length !== 4) {
    return res.status(400).json({ valid: false });
  }

  const filePath = `Token/${token}.txt`;

  try {
    const [fileExists] = await bucket.file(filePath).exists();
    return res.status(200).json({ valid: fileExists });
  } catch (error) {
    console.error('Error checking token:', error);
    return res.status(500).json({ valid: false });
  }
});

// Helper function to read student data
async function readStudentData() {
    try {
        const data = await fs.readFile(dataFilePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading student data:', error);
        return {};
    }
}
// Helper function to write student data
async function writeStudentData(data) {
    try {
        await fs.writeFile(dataFilePath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error writing student data:', error);
    }
}

app.post('/getStudentInfo', async (req, res) => {
    try {
        const { studentNumber } = req.body;
        
        // Fetch student data from Firestore
        const studentDoc = await admin.firestore().collection('students').doc(studentNumber).get();
        
        if (!studentDoc.exists) {
            return res.json({ success: false, message: 'Student not found' });
        }
        
        const studentData = studentDoc.data();
        
        // Fetch violations from Storage
        const filePath = `students/${studentNumber}/${studentNumber}violations.txt`;
        const [fileExists] = await bucket.file(filePath).exists();
        
        let lastViolations = 'None';
        if (fileExists) {
            const [content] = await bucket.file(filePath).download();
            const violations = content.toString('utf-8').split('\n').filter(Boolean);
            lastViolations = violations[violations.length - 1] || 'None';
        }
        
        res.json({
            success: true,
            studentInfo: {
                studentNumber,
                fullName: studentData.fullName,
                lastViolations,
                details: studentData.notice || 'No additional details'
            }
        });
    } catch (error) {
        console.error('Error fetching student data:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Assuming Firebase Admin SDK is already initialized

app.post('/admin/submitNotice', async (req, res) => {
    try {
        const { studentNumber, noticeText } = req.body;
        
        if (!studentNumber || !noticeText) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        
        const bucket = admin.storage().bucket();
        const fileName = `notice/${studentNumber}notice_${uuidv4()}.txt`;
        const file = bucket.file(fileName);

        const currentDate = new Date().toISOString();
        const fileContent = `Date: ${currentDate}\nNotice: ${noticeText}`;

        await file.save(fileContent, {
            metadata: {
                contentType: 'text/plain',
            },
        });
        
        res.json({ success: true, message: 'Notice submitted successfully' });
    } catch (error) {
        console.error('Error submitting notice:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});


// Fetch all notices
app.get('/admin/notices', async (req, res) => {
    try {
        const [files] = await bucket.getFiles({ prefix: 'notice/' });
        const notices = await Promise.all(files.map(async (file) => {
            const [content] = await file.download();
            return {
                fileName: file.name,
                content: content.toString('utf-8'),
                studentNumber: file.name.split('notice_')[0].replace('notice/', '')
            };
        }));
        res.json({ success: true, notices });
    } catch (error) {
        console.error('Error fetching notices:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Edit a notice
app.put('/admin/editNotice/:fileName', async (req, res) => {
    try {
        const { fileName } = req.params;
        const { newNotice } = req.body;

        if (!newNotice) {
            return res.status(400).json({ success: false, message: 'Missing new notice text' });
        }

        const file = bucket.file(fileName);
        const [exists] = await file.exists();
        if (!exists) {
            return res.status(404).json({ success: false, message: 'Notice not found' });
        }

        const currentDate = new Date().toISOString();
        const fileContent = `Date: ${currentDate}\nNotice: ${newNotice}`;

        await file.save(fileContent, {
            metadata: {
                contentType: 'text/plain',
            },
        });

        res.json({ success: true, message: 'Notice updated successfully' });
    } catch (error) {
        console.error('Error editing notice:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Remove a notice
app.delete('/admin/removeNotice/:fileName', async (req, res) => {
    try {
        const { fileName } = req.params;
        const file = bucket.file(fileName);

        const [exists] = await file.exists();
        if (!exists) {
            return res.status(404).json({ success: false, message: 'Notice not found' });
        }

        await file.delete();

        res.json({ success: true, message: 'Notice removed successfully' });
    } catch (error) {
        console.error('Error removing notice:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});



app.post('/validateMainBarcode', (req, res) => {
  const { studentNumber } = req.body;

  if (studentNumber && typeof studentNumber === 'string') {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.post('/logViolation', async (req, res) => {
    try {
        const { studentNumber, violations, date, manualEntry } = req.body;

        if (!studentNumber || !violations || !date) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Fetch student data to get grade and section
        const studentRef = admin.firestore().collection('students').doc(studentNumber);
        const studentDoc = await studentRef.get();

        if (!studentDoc.exists) {
            return res.status(404).json({ success: false, message: 'Student not found' });
        }

        const studentData = studentDoc.data();
        const { grade, section } = studentData;

        // Create the correct folder path
        const folderPath = getStudentFolderPath(grade, section, studentNumber);
        const filePath = `${folderPath}${studentNumber}_violations.txt`;

        // Check if the file exists
        const [fileExists] = await bucket.file(filePath).exists();

        let currentContent = '';
        if (fileExists) {
            // If file exists, download its content
            const [content] = await bucket.file(filePath).download();
            currentContent = content.toString('utf-8');
        }

        // Format the new violation log entry
        const logEntry = `${date}: ${violations.join(', ')}${manualEntry ? ' (Manual Entry)' : ''}\n`;

        // Combine existing content with new log entry
        const updatedContent = currentContent + logEntry;

        // Upload the updated content back to Firebase Storage
        await bucket.file(filePath).save(updatedContent, {
            contentType: 'text/plain',
            metadata: {
                cacheControl: 'private, max-age=0'
            }
        });

        // Update the student's record in Firestore
        await studentRef.set({
            lastViolationDate: date,
            violationsCount: admin.firestore.FieldValue.increment(1)
        }, { merge: true });

        res.json({ success: true, message: 'Violations logged successfully' });
    } catch (error) {
        console.error('Error logging violations:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});
app.post('/logMultipleViolations', async (req, res) => {
    try {
        const { studentNumber, violations, date, manualEntry } = req.body;

        if (!studentNumber || !violations || violations.length === 0 || !date) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const filePath = `students/${studentNumber}/${studentNumber}violations.txt`;

        // Check if the file exists
        const [fileExists] = await bucket.file(filePath).exists();

        let currentContent = '';
        if (fileExists) {
            // If file exists, download its content
            const [content] = await bucket.file(filePath).download();
            currentContent = content.toString('utf-8');
        }

        // Format the new violation log entry
        const logEntry = `${date}: ${violations.join(', ')}${manualEntry ? ' (Manual Entry)' : ''}\n`;

        // Combine existing content with new log entry
        const updatedContent = currentContent + logEntry;

        // Upload the updated content back to Firebase Storage
        await bucket.file(filePath).save(updatedContent, {
            contentType: 'text/plain',
            metadata: {
                cacheControl: 'private, max-age=0'
            }
        });

        // Update the student's record in Firestore
        const studentRef = admin.firestore().collection('students').doc(studentNumber);
        await studentRef.set({
            lastViolationDate: date,
            violationsCount: admin.firestore.FieldValue.increment(violations.length)
        }, { merge: true });

        res.json({ success: true, message: 'Violations logged successfully' });
    } catch (error) {
        console.error('Error logging violations:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.post('/createStudentFolder', async (req, res) => {
  const { studentNumber, fullName, grade, section } = req.body;

  if (!studentNumber || !fullName || !grade || !section) {
    return res.status(400).send("studentNumber, fullName, grade, and section are required.");
  }

  try {
    const folderPath = getStudentFolderPath(grade, section, studentNumber);
    const fileName = `${studentNumber}_main.txt`;
    const fileContent = `Student Number: ${studentNumber}\nFull Name: ${fullName}\nGrade: ${grade}\nSection: ${section}\n`;

    const file = bucket.file(`${folderPath}${fileName}`);
    await file.save(fileContent, {
      metadata: {
        contentType: 'text/plain',
      }
    });

    // Create Firestore document for the student
    await db.collection('students').doc(studentNumber).set({
      studentNumber,
      fullName,
      grade,
      section
    });

    console.log(`Folder and file created for student number: ${studentNumber}`);
    res.status(200).send(`Folder and file created successfully for ${studentNumber}.`);
  } catch (error) {
    console.error("Error creating folder or file:", error);
    res.status(500).send("Error creating folder or file.");
  }
});


app.post('/getStudentRecords', async (req, res) => {
  const { studentNumber, date } = req.body;

  if (!studentNumber || !date) {
    return res.status(400).json({ success: false, message: 'Student number and date are required' });
  }

  try {
    const studentRef = db.collection('students').doc(studentNumber);
    const studentDoc = await studentRef.get();

    if (!studentDoc.exists) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const studentData = studentDoc.data();
    const records = [];

    // Function to parse the specific date-time format
    
  // Adjust hours for PM
   function parseDateTime(dateTimeString) {
  // Remove "(Late)" or any other parenthetical information
  dateTimeString = dateTimeString.replace(/\s*\([^)]*\)/, '').trim();

  // Split the string into date and time parts
  const [datePart, timePart] = dateTimeString.split(', Time: ');

  if (!datePart || !timePart) {
    console.error(`Invalid date-time format: ${dateTimeString}`);
    return null;
  }

  const [year, month, day] = datePart.split('-').map(Number);
  
  // Split the time part and remove any empty strings
  const timeParts = timePart.split('_').filter(Boolean);

  if (timeParts.length < 4) {
    console.error(`Invalid time format: ${timePart}`);
    return null;
  }

  const [hourMinSec, period] = timeParts.slice(-2);

  if (!hourMinSec || !period) {
    console.error(`Invalid time format: ${timePart}`);
    return null;
  }

  const [hours, minutes, seconds] = hourMinSec.split(':').map(Number);

  // Adjust hours for PM
  const adjustedHours = period.toUpperCase() === 'PM' && hours !== 12 ? hours + 12 : hours;

  // Check if the parsed values are valid
  if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hours) || isNaN(minutes) || isNaN(seconds)) {
    console.error(`Invalid date components: ${dateTimeString}`);
    return null;
  }
  
  const date = new Date(year, month - 1, day, adjustedHours, minutes, seconds);
  
  // Check if the resulting date is valid
  if (isNaN(date.getTime())) {
    console.error(`Invalid date created from string: ${dateTimeString}`);
    return null;
  }
  
  return date;
   }
    // Function to check if a date matches the target date
    function dateMatches(dateTimeString, targetDate) {
  const parsedDate = parseDateTime(dateTimeString);
  if (parsedDate === null) {
    return false; // or handle the error as appropriate for your application
  }
  return parsedDate.toISOString().split('T')[0] === targetDate;
}


    // Check entry times
    if (studentData.entryTime) {
      studentData.entryTime.forEach(entry => {
        if (dateMatches(entry, date)) {
          records.push(entry);
        }
      });
    }

    // Check exit times
    if (studentData.exitTime) {
      studentData.exitTime.forEach(exit => {
        if (dateMatches(exit, date)) {
          records.push(exit);
        }
      });
    }

    // Check violations
    if (studentData.violations) {
      studentData.violations.forEach(violation => {
        const violationDate = new Date(violation.split('T')[0]).toISOString().split('T')[0];
        if (violationDate === date) {
          records.push(`Violation: ${violation}`);
        }
      });
    }

    // Sort records by time
    records.sort((a, b) => {
      const timeA = parseDateTime(a.includes('Violation') ? a.split(': ')[1] : a);
      const timeB = parseDateTime(b.includes('Violation') ? b.split(': ')[1] : b);
      return timeA - timeB;
    });

    res.json({ success: true, records });
  } catch (error) {
    console.error('Error fetching student records:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});


app.post('/getViolationsSummary', async (req, res) => {
  const { studentNumber } = req.body;

  if (!studentNumber) {
    return res.status(400).json({ success: false, message: 'Student number is required' });
  }

  try {
    const studentRef = db.collection('students').doc(studentNumber);
    const studentDoc = await studentRef.get();

    if (!studentDoc.exists) {
      return res.json({ success: true, violations: {} });
    }

    const studentData = studentDoc.data();
    const violationsSummary = {};

    if (studentData.violations) {
      studentData.violations.forEach(violation => {
        const [dateTime, violationTypes] = violation.split(': ');
        const types = violationTypes.split(', ');
        types.forEach(type => {
          if (!violationsSummary[type]) {
            violationsSummary[type] = { count: 0, dates: [] };
          }
          violationsSummary[type].count++;
          violationsSummary[type].dates.push(dateTime.split('T')[0]);
        });
      });
    }

    res.json({ success: true, violations: violationsSummary });
  } catch (error) {
    console.error('Error fetching violations summary:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/logClientConsole', (req, res) => {
  const { log } = req.body;
  
  if (log) {
    console.log(`Client Console Log: ${log}`);
    res.status(200).send('Log received');
  } else {
    res.status(400).send('No log provided');
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to handle redirects from '/' to '/entrance'
app.use((req, res, next) => {
  if (req.path === '/') {
    res.redirect('/entrance');
  } else {
    next();
  }
});

(async () => {
    try {
        await fs.access(dataFilePath);
    } catch {
        const initialData = {
            "23-0199": {
                studentNumber: "23-0199",
                fullName: "Shyron Dwight R. Loveres",
                violations: []
            }
        };
        await writeStudentData(initialData);
        console.log('Initial student data created.');
    }
})();

function parseTime(timeString) {
  const [hours, minutes] = timeString.split(':').map(Number);
  return { hours, minutes };
}
const dateString = "Entry Date: 2024-09-21, Time: 9_21_2024_ 10:06:40_PM (Late)";
const parsedDate = parseDateTime(dateString);
console.log("Parsed Date:", parsedDate);

const targetDate = "2024-09-21";
console.log("Date Matches:", dateMatches(dateString, targetDate));
// Define routes to serve HTML files
app.get('/entrance', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, '/Admin/settings.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '/Admin/dashboard.html'));
});


app.get('/notice', (req, res) => {
  res.sendFile(path.join(__dirname, '/Admin/notice.html'));
});

app.get('/manualviolation', (req, res) => {
  res.sendFile(path.join(__dirname, '/Admin/manualviolation.html'));
});


app.get('/UserCreate', (req, res) => {
  res.sendFile(path.join(__dirname, '/Admin/UserCreate.html'));
});

app.get('/studentsearch', (req, res) => {
  res.sendFile(path.join(__dirname, '/Admin/studentsearch.html'));
});

app.get('/searchdate', (req, res) => {
  res.sendFile(path.join(__dirname, '/Admin/searchdate.html'));
});
app.get('/usernotice', (req, res) => {
  res.sendFile(path.join(__dirname, '/Admin/usernotice.html'));
});




app.get('/active', (req, res) => {
  res.sendFile(path.join(__dirname, '/Admin/active.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '/Admin/AdminUser/login.html'));
});

app.get('/home', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});