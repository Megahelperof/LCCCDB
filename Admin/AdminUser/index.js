const serviceAccount = require('../lcccdb-891ca-firebase-adminsdk-h9lxo-5708b4b4b1.json');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'lcccdb-891ca.appspot.com'
});

// Middleware to check if user is authenticated
const checkAuth = async (req, res, next) => {
  const idToken = req.headers.authorization;
  if (!idToken) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    res.status(401).send('Unauthorized');
  }
};

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/Admin/dashboard', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'Admin', 'dashboard.html'));
});

app.get('/Admin/manualviolations', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'Admin', 'manualviolations.html'));
});

app.get('/Admin/notice', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'Admin', 'notice.html'));
});

app.get('/Admin/searchdate', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'Admin', 'searchdate.html'));
});

app.get('/Admin/settings', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'Admin', 'settings.html'));
});

app.get('/Admin/studentsearch', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'Admin', 'studentsearch.html'));
});

app.get('/Admin/usercreate', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'Admin', 'usercreate.html'));
});

// API routes
app.get('/api/user-role', checkAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const userRecord = await admin.auth().getUser(userId);
    const customClaims = userRecord.customClaims || {};
    res.json({ role: customClaims.role || 'user' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user role' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});