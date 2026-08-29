const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const csv = require('csv-parser');

const app = express();
const PORT = 3000;

// ตั้งค่าโฟลเดอร์อัปโหลด
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
const upload = multer({ dest: uploadDir });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// เชื่อมต่อฐานข้อมูล SQLite
const dbPath = path.join(__dirname, 'data', 'dictionary.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS dictionary (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT DEFAULT 'nouns',
            myanmar_text TEXT NOT NULL,
            thai_meaning TEXT NOT NULL,
            thai_phonetic TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// ---------- API: Login ----------
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'dhamma') {
        res.json({ success: true, token: 'admin-token' });
    } else {
        res.status(401).json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
});

// ---------- API: Export Backup (ดาวน์โหลด CSV) ----------
app.get('/api/export-backup', (req, res) => {
    const sql = 'SELECT category, myanmar_text, thai_meaning, thai_phonetic FROM dictionary ORDER BY id ASC';
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        let csvContent = 'category,myanmar_text,thai_meaning,thai_phonetic\n';
        rows.forEach(row => {
            const escape = (val) => `"${(val || '').replace(/"/g, '""')}"`;
            csvContent += `${escape(row.category || 'nouns')},${escape(row.myanmar_text)},${escape(row.thai_meaning)},${escape(row.thai_phonetic)}\n`;
        });

        // เติม BOM เพื่อให้ Excel อ่านภาษาไทยถูกต้อง
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=dictionary_backup.csv');
        res.send('\uFEFF' + csvContent);
    });
});

// ---------- API: Get Dictionary (พร้อม pagination & search/filter) ----------
app.get('/api/dictionary', (req, res) => {
    const q = req.query.q ? `%${req.query.q.trim()}%` : '%';
    const cat = req.query.cat || 'all';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    let whereClause = `WHERE (myanmar_text LIKE ? OR thai_meaning LIKE ? OR thai_phonetic LIKE ?)`;
    const params = [q, q, q];

    if (cat !== 'all') {
        whereClause += ` AND category = ?`;
        params.push(cat);
    }

    // นับจำนวนรายการทั้งหมด
    db.get(`SELECT COUNT(*) AS total FROM dictionary ${whereClause}`, params, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        const totalItems = row.total;
        const totalPages = Math.ceil(totalItems / limit) || 1;

        // ดึงข้อมูลตามหน้า
        db.all(
            `SELECT * FROM dictionary ${whereClause} ORDER BY category ASC, id DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });

                res.json({
                    data: rows,
                    pagination: {
                        currentPage: page,
                        totalPages,
                        totalItems,
                        itemsPerPage: limit
                    }
                });
            }
        );
    });
});

// ---------- API: Import CSV/TXT (รองรับ header หลายรูปแบบ) ----------
app.post('/api/upload-file', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์' });

    const results = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            // ลบไฟล์ชั่วคราว
            try { fs.unlinkSync(req.file.path); } catch (e) {}

            let importedCount = 0;
            for (const row of results) {
                const myanmar = row.myanmar_text || row['ภาษาพม่า'] || row['myanmar'];
                const meaning = row.thai_meaning || row['คำแปลไทย'] || row['meaning'] || '';
                const phonetic = row.thai_phonetic || row['คำอ่านไทย'] || row['phonetic'] || '';
                const category = row.category || row['หมวดหมู่'] || 'nouns';

                if (!myanmar) continue; // ข้ามแถวว่าง

                await new Promise((resolve) => {
                    db.run(
                        'INSERT INTO dictionary (category, myanmar_text, thai_meaning, thai_phonetic) VALUES (?, ?, ?, ?)',
                        [category, myanmar, meaning, phonetic],
                        () => resolve()
                    );
                });
                importedCount++;
            }

            res.json({ success: true, count: importedCount });
        })
        .on('error', (err) => {
            res.status(500).json({ error: err.message });
        });
});

// ---------- API: Update Entry ----------
app.put('/api/dictionary/:id', (req, res) => {
    const { id } = req.params;
    const { category, myanmar_text, thai_meaning, thai_phonetic } = req.body;
    db.run(
        'UPDATE dictionary SET category = ?, myanmar_text = ?, thai_meaning = ?, thai_phonetic = ? WHERE id = ?',
        [category, myanmar_text, thai_meaning, thai_phonetic, id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// ---------- API: Delete Single Entry ----------
app.delete('/api/dictionary/:id', (req, res) => {
    const { id } = req.params;
    db.run('DELETE FROM dictionary WHERE id = ?', [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ---------- API: Delete All Entries (ล้างข้อมูล) ----------
app.delete('/api/dictionary-all', (req, res) => {
    db.run('DELETE FROM dictionary', [], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// เริ่มเซิร์ฟเวอร์
app.listen(PORT, () => {
    console.log(`Dictionary App running at http://localhost:${PORT}`);
});
