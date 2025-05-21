const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.NODE_ENV === 'production' 
  ? '/tmp/task-manager.db'
  : path.join(__dirname, 'data.db');

// Enable CORS for production
if (process.env.NODE_ENV === 'production') {
  const cors = require('cors');
  app.use(cors());
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Database connection
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error connecting to database:', err);
    process.exit(1);
  }
  console.log('Connected to SQLite database');
  initDatabase();
});

// Initialize database with tables
function initDatabase() {
  db.serialize(() => {
    // Drop existing tables if they exist
    db.run(`DROP TABLE IF EXISTS tasks`);
    db.run(`DROP TABLE IF EXISTS users`);

    // Create users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      role TEXT
    )`);

    // Create tasks table with all required columns
    db.run(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      description TEXT,
      max_points INTEGER,
      assigned_user_id INTEGER,
      points INTEGER DEFAULT NULL,
      bonus_points INTEGER DEFAULT 0,
      remarks TEXT,
      status TEXT DEFAULT 'active',
      FOREIGN KEY(assigned_user_id) REFERENCES users(id)
    )`);

    // Check and create admin user
    db.get("SELECT * FROM users WHERE username = 'admin'", [], (err, row) => {
      if (!row) {
        db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`,
          ['admin', 'admin123', 'admin']
        );
      }
    });

    // Create a test user
    db.get("SELECT * FROM users WHERE username = 'test'", [], (err, row) => {
      if (!row) {
        db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`,
          ['test', 'test123', 'user']
        );
      }
    });
  });
}

// Routes

// Login route
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required' });
    }
    
    db.get('SELECT * FROM users WHERE username = ? AND password = ?', 
        [username, password], 
        (err, user) => {
            if (err) {
                console.error('Login error:', err.message);
                return res.status(500).json({ message: 'Server error' });
            }
            
            if (!user) {
                return res.status(401).json({ message: 'Invalid username or password' });
            }
            
            // Return user data without password
            const { password: _, ...userWithoutPassword } = user;
            res.json(userWithoutPassword);
        }
    );
});

// Get all users with total score
app.get('/api/users', (req, res) => {
  db.all(`
    SELECT u.id, u.username, u.role, 
           COALESCE(SUM(t.points), 0) as totalScore 
    FROM users u 
    LEFT JOIN tasks t ON u.id = t.assigned_user_id 
    GROUP BY u.id
  `, [], (err, users) => {
    if (err) {
      console.error('Error getting users', err.message);
      return res.status(500).json({ message: 'Server error' });
    }
    
    // Remove passwords before sending
    const usersWithoutPasswords = users.map(user => {
      const { password, ...userWithoutPassword } = user;
      return userWithoutPassword;
    });
    
    res.json(usersWithoutPasswords);
  });
});

// Get leaderboard
app.get('/api/leaderboard', (req, res) => {
  db.all(`
    SELECT u.id, u.username, 
           COALESCE(SUM(t.points), 0) as totalScore 
    FROM users u 
    LEFT JOIN tasks t ON u.id = t.assigned_user_id 
    WHERE u.role = 'user'
    GROUP BY u.id
    ORDER BY totalScore DESC
  `, [], (err, users) => {
    if (err) {
      console.error('Error getting leaderboard', err.message);
      return res.status(500).json({ message: 'Server error' });
    }
    
    res.json(users);
  });
});

// Get all tasks with assigned user names
app.get('/api/tasks', (req, res) => {
  db.all(`
    SELECT t.*, u.username as assignedUserName 
    FROM tasks t 
    LEFT JOIN users u ON t.assigned_user_id = u.id
  `, [], (err, tasks) => {
    if (err) {
      console.error('Error getting tasks', err.message);
      return res.status(500).json({ message: 'Server error' });
    }
    
    res.json(tasks);
  });
});

// Get a specific task
app.get('/api/tasks/:id', (req, res) => {
  const taskId = req.params.id;
  
  db.get(`
    SELECT t.*, u.username as assignedUserName 
    FROM tasks t 
    LEFT JOIN users u ON t.assigned_user_id = u.id 
    WHERE t.id = ?
  `, [taskId], (err, task) => {
    if (err) {
      console.error('Error getting task', err.message);
      return res.status(500).json({ message: 'Server error' });
    }
    
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    
    res.json(task);
  });
});

// Create a new task
app.post('/api/tasks', (req, res) => {
    const { title, description, maxPoints, assignedUserId } = req.body;
    
    console.log('Creating task with:', { title, description, maxPoints, assignedUserId });
    
    if (!title || !description || !maxPoints) {
        return res.status(400).json({ message: 'Title, description, and max points are required' });
    }

    const status = assignedUserId ? 'assigned' : 'unassigned';

    db.run(`
        INSERT INTO tasks (
            title, 
            description, 
            max_points, 
            assigned_user_id, 
            status,
            points,
            bonus_points
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
        title, 
        description, 
        maxPoints, 
        assignedUserId || null,
        status,
        null,
        0
    ], function(err) {
        if (err) {
            console.error('Error creating task:', err);
            return res.status(500).json({ message: 'Error creating task' });
        }

        // Get the created task with user details
        db.get(`
            SELECT 
                t.*, 
                u.username as assignedUserName 
            FROM tasks t 
            LEFT JOIN users u ON t.assigned_user_id = u.id 
            WHERE t.id = ?
        `, [this.lastID], (err, task) => {
            if (err) {
                console.error('Error fetching created task:', err);
                return res.status(500).json({ message: 'Task created but failed to fetch details' });
            }
            res.json(task);
        });
    });
});

// Update a task
app.put('/api/tasks/:id', (req, res) => {
    const taskId = req.params.id;
    const { title, description, maxPoints, assignedUserId } = req.body;
    
    if (!title || !maxPoints) {
        return res.status(400).json({ message: 'Title and maxPoints are required' });
    }
    
    const status = assignedUserId ? 'assigned' : 'unassigned';
    
    db.run(`
        UPDATE tasks 
        SET title = ?, 
            description = ?, 
            max_points = ?, 
            assigned_user_id = ?,
            status = ?
        WHERE id = ?
    `, [title, description, maxPoints, assignedUserId || null, status, taskId], function(err) {
        if (err) {
            console.error('Error updating task:', err);
            return res.status(500).json({ message: 'Server error' });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ message: 'Task not found' });
        }
        
        // Get updated task with user details
        db.get(`
            SELECT t.*, u.username as assignedUserName 
            FROM tasks t 
            LEFT JOIN users u ON t.assigned_user_id = u.id 
            WHERE t.id = ?
        `, [taskId], (err, task) => {
            if (err) {
                console.error('Error fetching updated task:', err);
                return res.status(500).json({ message: 'Task updated but failed to fetch details' });
            }
            res.json(task);
        });
    });
});

// Update the existing points route
app.post('/api/tasks/:id/points', (req, res) => {
    const taskId = req.params.id;
    const { points, bonus_points = 0, remarks } = req.body;
    
    if (points === undefined) {
        return res.status(400).json({ message: 'Points are required' });
    }
    
    // First verify the task exists and get max points
    db.get('SELECT max_points, assigned_user_id FROM tasks WHERE id = ?', [taskId], (err, task) => {
        if (err) {
            console.error('Error fetching task:', err);
            return res.status(500).json({ message: 'Error fetching task' });
        }
        if (!task) {
            return res.status(404).json({ message: 'Task not found' });
        }
        
        // Validate points
        if (points < 0 || points > task.max_points) {
            return res.status(400).json({ 
                message: `Points must be between 0 and ${task.max_points}` 
            });
        }
        
        // Update task with points and mark as completed
        db.run(`
            UPDATE tasks 
            SET points = ?, 
                bonus_points = ?,
                remarks = ?,
                status = 'completed'
            WHERE id = ?
        `, [points, bonus_points || 0, remarks || '', taskId], function(err) {
            if (err) {
                console.error('Error updating points:', err);
                return res.status(500).json({ message: 'Error updating points' });
            }
            
            if (this.changes === 0) {
                return res.status(404).json({ message: 'Task not found' });
            }
            
            res.json({ 
                message: 'Points assigned successfully',
                points: points,
                bonus_points: bonus_points,
                total_points: points + bonus_points
            });
        });
    });
});

// Get tasks for a specific user
app.get('/api/users/:id/tasks', (req, res) => {
  const userId = req.params.id;
  
  db.all('SELECT * FROM tasks WHERE assigned_user_id = ?', [userId], (err, tasks) => {
    if (err) {
      console.error('Error getting user tasks', err.message);
      return res.status(500).json({ message: 'Server error' });
    }
    
    res.json(tasks);
  });
});

// Create new user
app.post('/api/users', (req, res) => {
    const { username, password, role } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required' });
    }
    
    db.run(
        'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
        [username, password, role || 'user'],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(400).json({ message: 'Username already exists' });
                }
                return res.status(500).json({ message: 'Error creating user' });
            }
            res.json({ id: this.lastID, username, role });
        }
    );
});

// Update user password
app.put('/api/users/:id/password', (req, res) => {
    const { password } = req.body;
    const userId = req.params.id;
    
    if (!password) {
        return res.status(400).json({ message: 'Password is required' });
    }
    
    db.run(
        'UPDATE users SET password = ? WHERE id = ?',
        [password, userId],
        function(err) {
            if (err) {
                return res.status(500).json({ message: 'Error updating password' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ message: 'User not found' });
            }
            res.json({ message: 'Password updated successfully' });
        }
    );
});

// Add these new routes
app.post('/api/tasks/:id/bonus', (req, res) => {
    const taskId = req.params.id;
    const { bonus_points, remarks } = req.body;
    
    db.run(
        'UPDATE tasks SET bonus_points = bonus_points + ?, remarks = COALESCE(remarks, "") || " [Bonus: " || ? || "]" WHERE id = ?',
        [bonus_points, remarks, taskId],
        function(err) {
            if (err) {
                return res.status(500).json({ message: 'Error awarding bonus points' });
            }
            res.json({ message: 'Bonus points awarded successfully' });
        }
    );
});

// Add this new route before the server start
app.post('/api/tasks/:id/end', (req, res) => {
    const taskId = req.params.id;
    const { status = 'failed', remarks = 'Task ended without points' } = req.body;
    
    db.run(`
        UPDATE tasks 
        SET status = ?,
            remarks = ?,
            points = 0,
            bonus_points = 0
        WHERE id = ?
    `, [status, remarks, taskId], function(err) {
        if (err) {
            console.error('Error ending task:', err);
            return res.status(500).json({ message: 'Error ending task' });
        }
        res.json({ message: 'Task ended successfully' });
    });
});

// Route to handle frontend routes
app.get(['/', '/admin', '/user'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Add specific routes for admin and user pages
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/user.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

// Health check route
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Close the database on exit
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error('Error closing database', err.message);
    } else {
      console.log('Database connection closed');
    }
    process.exit(0);
  });
});