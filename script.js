class StudyBuddy {
    constructor() { 
        this.db = null; 
        this.data = null; 
        this.currentSemesterId = null; 
        this.selectedSubjectId = null; 
        this.timerInterval = null;
        this.timerSeconds = 25 * 60;
        this.timerRunning = false;
        this.init(); 
    }
    
    async init() { 
        await this.initDB(); 
        this.attachEventListeners(); 
        this.setupTabs(); 
        if (this.data?.semesters.length) { 
            this.currentSemesterId = this.data.semesters[0].id; 
            this.renderSemesterSelector(); 
            this.renderSubjects(); 
            this.loadSemesterNotebook(); 
        } else { 
            this.renderSemesterSelector(); 
            this.renderSubjects(); 
        } 
        this.updateStats(); 
        
        // Load dark mode preference
        const savedDarkMode = localStorage.getItem('darkMode');
        if (savedDarkMode === 'true') {
            document.body.classList.add('dark-mode');
            const btn = document.getElementById('darkModeBtn');
            if (btn) btn.innerHTML = '<i class="fas fa-sun"></i> Light Mode';
        } else {
            // Ensure light mode is default
            document.body.classList.remove('dark-mode');
            const btn = document.getElementById('darkModeBtn');
            if (btn) btn.innerHTML = '<i class="fas fa-moon"></i> Dark Mode';
        }        
        // Setup file search
        this.setupFileSearch();
        
        // Clean up any existing HTML in summaries
        await this.cleanupExistingSummaries();
        
        this.showToast('🐻‍❄️ Ready! Click any file to view in new tab 💖');
    }
    
    async cleanupExistingSummaries() {
        let cleanedCount = 0;
        for (const semester of this.data.semesters) {
            for (const subject of semester.subjects) {
                if (subject.files) {
                    for (const file of subject.files) {
                        if (file.summaryNotes && file.summaryNotes.includes('<')) {
                            const cleaned = file.summaryNotes.replace(/<[^>]*>/g, '').trim();
                            if (cleaned !== file.summaryNotes) {
                                file.summaryNotes = cleaned;
                                cleanedCount++;
                                const fileData = await this.getFileFromDB(file.id);
                                if (fileData) {
                                    fileData.summaryNotes = cleaned;
                                    this.db?.transaction(['files'], 'readwrite').objectStore('files').put(fileData);
                                }
                            }
                        }
                    }
                }
            }
        }
        if (cleanedCount > 0) {
            await this.saveDataToDB();
            this.showToast(`🧹 Cleaned ${cleanedCount} file summaries!`);
        }
    }
    
    // ==================== DATABASE METHODS ====================
    
    initDB() { 
        return new Promise((resolve) => { 
            const request = indexedDB.open('StudyBuddyDB', 5); 
            request.onerror = () => { 
                this.data = this.getDefaultData(); 
                this.saveToLocalStorage(); 
                resolve(); 
            }; 
            request.onsuccess = (event) => { 
                this.db = event.target.result; 
                this.loadDataFromDB().then(() => resolve()); 
            }; 
            request.onupgradeneeded = (event) => { 
                const db = event.target.result; 
                if (!db.objectStoreNames.contains('appData')) 
                    db.createObjectStore('appData', { keyPath: 'id' }); 
                if (!db.objectStoreNames.contains('files')) { 
                    const fileStore = db.createObjectStore('files', { keyPath: 'id' }); 
                    fileStore.createIndex('subjectId', 'subjectId', { unique: false }); 
                } 
            }; 
        }); 
    }
    
    loadDataFromDB() { 
        return new Promise((resolve) => { 
            if (!this.db) { 
                this.data = this.getDefaultData(); 
                resolve(); 
                return; 
            } 
            const transaction = this.db.transaction(['appData'], 'readonly'); 
            const request = transaction.objectStore('appData').get('mainData'); 
            request.onsuccess = () => { 
                this.data = (request.result && request.result.data) ? request.result.data : this.getDefaultData(); 
                resolve(); 
            }; 
            request.onerror = () => { 
                this.data = this.getDefaultData(); 
                resolve(); 
            }; 
        }); 
    }
    
    saveDataToDB() { 
        return new Promise((resolve) => { 
            if (!this.db) { 
                this.saveToLocalStorage(); 
                this.updateStats(); 
                resolve(); 
                return; 
            } 
            const transaction = this.db.transaction(['appData'], 'readwrite'); 
            transaction.objectStore('appData').put({ id: 'mainData', data: this.data }); 
            transaction.oncomplete = () => { 
                this.updateStats(); 
                resolve(); 
            }; 
            transaction.onerror = () => { 
                this.saveToLocalStorage(); 
                this.updateStats(); 
                resolve(); 
            }; 
        }); 
    }
    
    saveToLocalStorage() { 
        localStorage.setItem('studyBuddyBackup', JSON.stringify(this.data)); 
    }
    
    async saveFileToDB(file, subjectId) {
        if (!this.db) return;
        try {
            const transaction = this.db.transaction(['files'], 'readwrite');
            const store = transaction.objectStore('files');
            store.put({
                id: file.id,
                subjectId: subjectId,
                name: file.name,
                size: file.size,
                type: file.type,
                data: file.data,
                summaryNotes: file.summaryNotes || '',
                uploadedAt: file.uploadedAt
            });
            return new Promise((resolve, reject) => {
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
        } catch(e) { console.error('Save to DB failed:', e); }
    }
    
    async getFileFromDB(fileId) { 
        if (!this.db) return null; 
        return new Promise(resolve => { 
            const req = this.db.transaction(['files'], 'readonly').objectStore('files').get(fileId); 
            req.onsuccess = () => resolve(req.result); 
            req.onerror = () => resolve(null); 
        }); 
    }
    
    async deleteFileFromDB(fileId) { 
        if (!this.db) return; 
        this.db.transaction(['files'], 'readwrite').objectStore('files').delete(fileId); 
    }
    
    // ==================== BACKUP & RESTORE (FIXED) ====================
    
    async exportToJSON() { 
        this.showToast('📦 Creating backup...');
        
        // Create a deep copy of the data
        const backup = { 
            version: "3.0", 
            exportDate: new Date().toISOString(), 
            data: JSON.parse(JSON.stringify(this.data))
        }; 
        
        // Embed file data
        let fileCount = 0;
        for (const semester of backup.data.semesters) {
            for (const subject of semester.subjects) {
                if (subject.files && subject.files.length) {
                    for (const file of subject.files) {
                        try {
                            const fileData = await this.getFileFromDB(file.id);
                            if (fileData && fileData.data) {
                                file.embeddedData = fileData.data;
                                fileCount++;
                            } else if (file.data) {
                                file.embeddedData = file.data;
                                fileCount++;
                            }
                        } catch(e) {
                            console.log('Could not backup file:', file.name);
                        }
                    }
                }
            }
        }
        
        const jsonStr = JSON.stringify(backup, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' }); 
        const a = document.createElement('a'); 
        a.href = URL.createObjectURL(blob); 
        a.download = `studybaby_backup_${Date.now()}.json`; 
        a.click(); 
        URL.revokeObjectURL(a.href); 
        this.showToast(`✨ Backup saved with ${fileCount} files!`); 
    }

    async importFromJSON(file) { 
        const reader = new FileReader(); 
        reader.onload = async (e) => { 
            try { 
                const imported = JSON.parse(e.target.result); 
                
                // Check for valid backup format
                if (imported.data?.semesters) { 
                    if (confirm('⚠️ Replace current data? This will overwrite everything.')) { 
                        this.showToast('📀 Restoring...');
                        
                        // Clear existing files from IndexedDB
                        if (this.db) {
                            try {
                                const transaction = this.db.transaction(['files'], 'readwrite');
                                transaction.objectStore('files').clear();
                                await new Promise((resolve) => { transaction.oncomplete = resolve; });
                            } catch(err) {
                                console.log('Could not clear files:', err);
                            }
                        }
                        
                        // Replace the data
                        this.data = imported.data;
                        
                        // Restore embedded files
                        let restoredCount = 0;
                        for (const semester of this.data.semesters) {
                            for (const subject of semester.subjects) {
                                if (subject.files && subject.files.length) {
                                    for (const file of subject.files) {
                                        const fileData = file.embeddedData || file.data;
                                        if (fileData) {
                                            try {
                                                const dbFile = {
                                                    id: file.id,
                                                    subjectId: subject.id,
                                                    name: file.name,
                                                    size: file.size,
                                                    type: file.type,
                                                    data: fileData,
                                                    summaryNotes: file.summaryNotes || '',
                                                    uploadedAt: file.uploadedAt || new Date().toISOString()
                                                };
                                                await this.saveFileToDB(dbFile, subject.id);
                                                file.data = fileData;
                                                delete file.embeddedData;
                                                restoredCount++;
                                            } catch(e) {
                                                console.log('Could not restore file:', file.name, e);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        
                        await this.saveDataToDB(); 
                        this.currentSemesterId = this.data.semesters[0]?.id || null; 
                        this.selectedSubjectId = null; 
                        this.renderSemesterSelector(); 
                        this.renderSubjects(); 
                        this.loadSemesterNotebook(); 
                        document.getElementById('subjectFilesArea').style.display = 'none'; 
                        this.showToast(`🎉 Restored ${restoredCount} files!`); 
                    } 
                } else if (imported.semesters) {
                    // Legacy format support
                    if (confirm('⚠️ Replace current data? This will overwrite everything.')) { 
                        this.showToast('📀 Restoring legacy backup...');
                        
                        if (this.db) {
                            try {
                                const transaction = this.db.transaction(['files'], 'readwrite');
                                transaction.objectStore('files').clear();
                                await new Promise((resolve) => { transaction.oncomplete = resolve; });
                            } catch(err) {}
                        }
                        
                        this.data = { semesters: imported.semesters, version: "3.0" };
                        await this.saveDataToDB(); 
                        this.currentSemesterId = this.data.semesters[0]?.id || null; 
                        this.selectedSubjectId = null; 
                        this.renderSemesterSelector(); 
                        this.renderSubjects(); 
                        this.loadSemesterNotebook(); 
                        this.showToast(`🎉 Legacy backup restored!`); 
                    }
                } else { 
                    this.showToast('❌ Invalid backup file format'); 
                } 
            } catch(err) { 
                console.error(err);
                this.showToast('❌ Error restoring backup: ' + err.message); 
            } 
        }; 
        reader.readAsText(file); 
    }
    
    // ==================== RENDER METHODS ====================
    
    getDefaultData() { 
        const now = Date.now(); 
        return { 
            version: "3.0", 
            semesters: [{ 
                id: now, 
                name: "🌸 Spring 2025", 
                semesterNotebook: "🌟 My semester goals: Stay consistent, review weekly, and enjoy learning!", 
                subjects: [{ 
                    id: now+1, 
                    name: "Cozy UX Design", 
                    completion: "Project only", 
                    files: [], 
                    overallSubjectNotes: "Make interfaces feel like a hug 💌", 
                    notebookNotes: "🎨 User research is key. Always prototype first.", 
                    createdAt: new Date().toISOString() 
                }, { 
                    id: now+2, 
                    name: "Creative Coding", 
                    completion: "Exam + Project", 
                    files: [], 
                    overallSubjectNotes: "p5.js + fun animations", 
                    notebookNotes: "💡 Remember: coordinates, loops, and interactivity.", 
                    createdAt: new Date().toISOString() 
                }], 
                createdAt: new Date().toISOString() 
            }] 
        }; 
    }
    
    renderSemesterSelector() {
        const selector = document.getElementById('semesterSelector');
        if (!selector) return;
        
        selector.innerHTML = this.data.semesters.map(s => 
            `<option value="${s.id}" ${this.currentSemesterId === s.id ? 'selected' : ''}>📚 ${this.escape(s.name)}</option>`
        ).join('');
    }
    
    renderSubjects() {
        const container = document.getElementById('subjectsList');
        const semester = this.getCurrentSemester();
        if (!container || !semester) return;
        
        if (!semester.subjects.length) {
            container.innerHTML = '<div style="text-align:center; padding:2rem;">✨ No subjects yet, add one! ✨</div>';
            return;
        }
        
        container.innerHTML = semester.subjects.map(sub => `
            <div class="subject-bubble ${this.selectedSubjectId === sub.id ? 'selected' : ''}" data-subject-id="${sub.id}">
                <div>
                    <span class="subject-name-cute">📖 ${this.escape(sub.name)}</span>
                    <span class="badge-completion">${sub.completion || 'Exam only'}</span>
                </div>
                <div class="subject-actions">
                    <button class="mini-btn edit" data-subject-id="${sub.id}" data-action="edit">✏️ Edit</button>
                    <button class="mini-btn danger" data-subject-id="${sub.id}" data-action="delete">🗑️ Delete</button>
                </div>
            </div>
        `).join('');
        
        // Attach click handlers for subjects
        document.querySelectorAll('.subject-bubble').forEach(el => {
            el.addEventListener('click', (e) => {
                // Don't trigger if clicking on buttons
                if (e.target.classList.contains('mini-btn')) return;
                const subjectId = parseInt(el.dataset.subjectId);
                this.selectSubject(subjectId);
            });
        });
        
        // Attach edit/delete handlers
        document.querySelectorAll('.mini-btn.edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const subjectId = parseInt(btn.dataset.subjectId);
                this.editSubject(subjectId);
            });
        });
        
        document.querySelectorAll('.mini-btn.danger').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const subjectId = parseInt(btn.dataset.subjectId);
                this.deleteSubject(subjectId);
            });
        });
    }
    
    renderFiles() { 
        const sub = this.getSubject(this.selectedSubjectId); 
        const container = document.getElementById('filesList'); 
        if (!container || !sub) return; 
        
        if (!sub.files?.length) { 
            container.innerHTML = '<div style="text-align:center;padding:1rem;">📎 no files yet, upload sweet notes 💗</div>'; 
            return; 
        }
        
        container.innerHTML = sub.files.map((f, idx) => `
            <div class="file-card">
                <div><i class="fas fa-paperclip"></i> ${this.escape(f.name)} <span style="background:#f0e6ff; border-radius:30px; padding:0.1rem 0.5rem;">${this.detectLanguage(f.name)}</span> <small>${this.formatSize(f.size)}</small></div>
                <textarea class="file-summary-input" data-idx="${idx}" rows="2" placeholder="add cute summary ..." style="width:100%; border-radius:40px; margin:5px 0; padding:0.5rem;">${this.escape(f.summaryNotes || '')}</textarea>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="pill-btn save-summary-btn" data-idx="${idx}">💾 Save summary</button>
                    <button class="pill-btn view-file-btn" data-idx="${idx}" style="background:#a5f3fc;">👁️ View in New Tab</button>
                    <button class="pill-btn delete-file-btn" data-idx="${idx}" style="background:#ffe0e0;">❌ Delete</button>
                </div>
            </div>
        `).join('');
        
        this.attachFileEventListeners();
    }
    
    attachFileEventListeners() {
        const container = document.getElementById('filesList');
            if (!container) return;
            const sub = this.getSubject(this.selectedSubjectId);
            if (!sub) return;
            
            // Save button
            for (let btn of container.querySelectorAll('.save-summary-btn')) {
                btn.removeEventListener('click', btn._listener);
                // In attachFileEventListeners method, update the save button listener:
    const listener = async (e) => {
        const idx = parseInt(btn.dataset.idx);
        const ta = container.querySelector(`.file-summary-input[data-idx="${idx}"]`);
        if (ta && sub.files[idx]) {
            // CRITICAL: Strip all HTML tags before saving
            let plainText = ta.value.replace(/<[^>]*>/g, '').trim();
            
            console.log("Saving cleaned:", plainText);
            
            sub.files[idx].summaryNotes = plainText;
            const fileData = await this.getFileFromDB(sub.files[idx].id);
            if (fileData) {
                fileData.summaryNotes = plainText;
                this.db?.transaction(['files'], 'readwrite').objectStore('files').put(fileData);
            }
            await this.saveDataToDB();
            this.showToast('file summary saved!');
            
            // Refresh view to show saved content
            this.renderFiles();
        }
    };
            btn.addEventListener('click', listener);
            btn._listener = listener;
        }
        
        // View button
        for (let btn of container.querySelectorAll('.view-file-btn')) {
            btn.removeEventListener('click', btn._viewListener);
            const listener = async () => {
                const idx = parseInt(btn.dataset.idx);
                if (sub.files[idx]) await this.openFileInNewTab(sub.files[idx]);
            };
            btn.addEventListener('click', listener);
            btn._viewListener = listener;
        }
        
        // Delete button
        for (let btn of container.querySelectorAll('.delete-file-btn')) {
            btn.removeEventListener('click', btn._deleteListener);
            const listener = async () => {
                if (confirm('Delete this file? 🗑️')) {
                    const idx = parseInt(btn.dataset.idx);
                    const fileId = sub.files[idx].id;
                    await this.deleteFileFromDB(fileId);
                    sub.files.splice(idx, 1);
                    await this.saveDataToDB();
                    this.renderFiles();
                    this.showToast('file removed');
                }
            };
            btn.addEventListener('click', listener);
            btn._deleteListener = listener;
        }
    }
    
    // ==================== SUBJECT METHODS ====================
    
    selectSubject(subjectId) {
        this.selectedSubjectId = subjectId;
        this.renderSubjects();
        
        const subject = this.getSubject(subjectId);
        if (subject) {
            document.getElementById('selectedSubjectInfo').innerHTML = `
                <div style="background:#ffe2f0; border-radius:40px; padding:0.8rem; text-align:center; margin-bottom:1rem;">
                    🎀 <strong>${this.escape(subject.name)}</strong> • ${subject.completion || 'Exam only'}
                </div>
            `;
            document.getElementById('subjectFilesArea').style.display = 'block';
            document.getElementById('subjectOverallNotes').value = subject.overallSubjectNotes || '';
            document.getElementById('subjectNotebook').value = subject.notebookNotes || '';
            this.renderFiles();
        }
    }
    
    addSubject(name, completionType) {
        if (!name.trim()) {
            this.showToast('Please enter a subject name!');
            return;
        }
        const semester = this.getCurrentSemester();
        if (semester) {
            semester.subjects.push({
                id: Date.now(),
                name: name.trim(),
                completion: completionType,
                files: [],
                overallSubjectNotes: '',
                notebookNotes: '',
                createdAt: new Date().toISOString()
            });
            this.saveDataToDB();
            this.renderSubjects();
            document.getElementById('newSubjectName').value = '';
            this.showToast(`📚 Added ${name}`);
        }
    }
    
    async editSubject(subjectId) {
        const subject = this.getSubject(subjectId);
        if (!subject) return;
        const newName = prompt('Edit subject name:', subject.name);
        if (newName && newName.trim()) {
            subject.name = newName.trim();
            await this.saveDataToDB();
            this.renderSubjects();
            if (this.selectedSubjectId === subjectId) {
                this.selectSubject(subjectId);
            }
            this.showToast('Subject updated!');
        }
    }
    
    async deleteSubject(subjectId) {
        if (confirm('Delete this subject and all its files?')) {
            const subject = this.getSubject(subjectId);
            if (subject && subject.files) {
                for (const file of subject.files) {
                    await this.deleteFileFromDB(file.id);
                }
            }
            const semester = this.getCurrentSemester();
            semester.subjects = semester.subjects.filter(s => s.id !== subjectId);
            if (this.selectedSubjectId === subjectId) {
                this.selectedSubjectId = null;
                document.getElementById('subjectFilesArea').style.display = 'none';
                document.getElementById('selectedSubjectInfo').innerHTML = '<div style="padding:1rem;">🍬 pick a subject</div>';
            }
            await this.saveDataToDB();
            this.renderSubjects();
            this.showToast('Subject deleted');
        }
    }
    
    // ==================== NOTEBOOK METHODS ====================
    
    saveSubjectNotes() {
        const subject = this.getSubject(this.selectedSubjectId);
        if (subject) {
            subject.overallSubjectNotes = document.getElementById('subjectOverallNotes').value;
            this.saveDataToDB();
            this.showToast('Subject notes saved!');
        }
    }
    
    saveSubjectNotebook() {
        const subject = this.getSubject(this.selectedSubjectId);
        if (subject) {
            subject.notebookNotes = document.getElementById('subjectNotebook').value;
            this.saveDataToDB();
            this.showToast('Subject notebook saved!');
        }
    }
    
    loadSemesterNotebook() {
        const semester = this.getCurrentSemester();
        if (semester && semester.semesterNotebook) {
            document.getElementById('semesterNotebook').value = semester.semesterNotebook;
        } else if (semester) {
            document.getElementById('semesterNotebook').value = '';
        }
    }
    
    saveSemesterNotebook() {
        const semester = this.getCurrentSemester();
        if (semester) {
            semester.semesterNotebook = document.getElementById('semesterNotebook').value;
            this.saveDataToDB();
            this.showToast('Semester notebook saved!');
        }
    }
    
    // ==================== SEMESTER METHODS ====================
    
    addSemester(name) {
        this.data.semesters.push({
            id: Date.now(),
            name: name,
            semesterNotebook: '',
            subjects: [],
            createdAt: new Date().toISOString()
        });
        this.saveDataToDB();
        this.currentSemesterId = this.data.semesters[this.data.semesters.length - 1].id;
        this.selectedSubjectId = null;
        this.renderSemesterSelector();
        this.renderSubjects();
        this.loadSemesterNotebook();
        document.getElementById('subjectFilesArea').style.display = 'none';
        this.showToast(`🎓 New semester: ${name}`);
    }
    
    async deleteCurrentSemester() {
        if (this.data.semesters.length <= 1) {
            this.showToast('Cannot delete the last semester!');
            return;
        }
        const semester = this.getCurrentSemester();
        if (confirm(`Delete semester "${semester?.name}" and everything inside?`)) {
            // Delete all files in this semester
            for (const subject of semester.subjects) {
                for (const file of subject.files) {
                    await this.deleteFileFromDB(file.id);
                }
            }
            this.data.semesters = this.data.semesters.filter(s => s.id !== this.currentSemesterId);
            this.currentSemesterId = this.data.semesters[0].id;
            this.selectedSubjectId = null;
            await this.saveDataToDB();
            this.renderSemesterSelector();
            this.renderSubjects();
            this.loadSemesterNotebook();
            document.getElementById('subjectFilesArea').style.display = 'none';
            this.showToast('Semester deleted');
        }
    }
    
    editSemesterName() {
        const semester = this.getCurrentSemester();
        if (semester) {
            const newName = prompt('Edit semester name:', semester.name);
            if (newName && newName.trim()) {
                semester.name = newName.trim();
                this.saveDataToDB();
                this.renderSemesterSelector();
                this.showToast('Semester renamed!');
            }
        }
    }
    
    // ==================== FILE METHODS ====================
    
    async handleFileUpload(files) {
        const subject = this.getSubject(this.selectedSubjectId);
        if (!subject) {
            this.showToast('Please select a subject first!');
            return;
        }
        
        for (const file of files) {
            const reader = new FileReader();
            const fileId = Date.now() + Math.random();
            
            const fileData = {
                id: fileId,
                name: file.name,
                size: file.size,
                type: file.type,
                data: null,
                summaryNotes: '',
                uploadedAt: new Date().toISOString()
            };
            
            reader.onload = async (e) => {
                fileData.data = e.target.result;
                await this.saveFileToDB(fileData, subject.id);
                subject.files.push({
                    id: fileId,
                    name: file.name,
                    size: file.size,
                    type: file.type,
                    summaryNotes: '',
                    uploadedAt: new Date().toISOString()
                });
                await this.saveDataToDB();
                this.renderFiles();
                this.showToast(`📎 ${file.name} uploaded!`);
            };
            reader.readAsDataURL(file);
        }
    }
    
    async openFileInNewTab(file) {
        const fileData = await this.getFileFromDB(file.id);
        if (fileData && fileData.data) {
            const blob = this.dataURLToBlob(fileData.data);
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } else {
            this.showToast('Could not open file');
        }
    }
    
    dataURLToBlob(dataURL) {
        const arr = dataURL.split(',');
        const mime = arr[0].match(/:(.*?);/)[1];
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
        }
        return new Blob([u8arr], { type: mime });
    }
    
    // ==================== SUMMARY METHODS ====================
    
    async generateSummary() {
        const semester = this.getCurrentSemester();
        if (!semester) return;
        
        let summary = `🌸 SEMESTER SUMMARY: ${semester.name} 🌸\n`;
        summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        // Semester notebook
        if (semester.semesterNotebook && semester.semesterNotebook.trim()) {
            summary += `📓 SEMESTER NOTEBOOK:\n${semester.semesterNotebook}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        }
        
        for (const subject of semester.subjects) {
            summary += `📖 SUBJECT: ${subject.name} (${subject.completion})\n`;
            summary += `${'─'.repeat(50)}\n`;
            
            if (subject.overallSubjectNotes && subject.overallSubjectNotes.trim()) {
                summary += `📝 Subject Notes: ${subject.overallSubjectNotes}\n\n`;
            }
            
            if (subject.notebookNotes && subject.notebookNotes.trim()) {
                summary += `📓 Subject Notebook:\n${subject.notebookNotes}\n\n`;
            }
            
            if (subject.files && subject.files.length) {
                summary += `📎 Files (${subject.files.length}):\n`;
                for (const file of subject.files) {
                    summary += `  • ${file.name}`;
                    if (file.summaryNotes && file.summaryNotes.trim()) {
                        summary += `\n    💬 Notes: ${file.summaryNotes}`;
                    }
                    summary += `\n`;
                }
                summary += `\n`;
            }
            
            summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        }
        
        document.getElementById('semesterSummary').innerHTML = `<pre style="white-space:pre-wrap; font-family:inherit;">${this.escape(summary)}</pre>`;
        this.showToast('Summary generated! ✨');
    }
    
    exportSummary() {
        const summaryDiv = document.getElementById('semesterSummary');
        if (!summaryDiv) return;
        
        const text = summaryDiv.innerText || summaryDiv.textContent;
        const blob = new Blob([text], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `semester_summary_${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(a.href);
        this.showToast('Summary exported! 📄');
    }
    
    // ==================== VIEWS & MODALS ====================
    
    async openFilesByLanguage() {
        const subject = this.getSubject(this.selectedSubjectId);
        if (!subject || !subject.files?.length) {
            this.showToast('No files in this subject!');
            return;
        }
        
        const filesByLang = {};
        for (const file of subject.files) {
            const lang = this.detectLanguage(file.name);
            if (!filesByLang[lang]) filesByLang[lang] = [];
            filesByLang[lang].push(file);
        }
        
        const modalBody = document.getElementById('langModalBody');
        modalBody.innerHTML = Object.entries(filesByLang).map(([lang, files]) => `
            <div style="margin-bottom:1.5rem;">
                <h4 style="color:#db2777;">📁 ${lang} (${files.length})</h4>
                ${files.map(f => `<div style="margin-left:1rem; padding:0.3rem;">📄 ${this.escape(f.name)} <small>${this.formatSize(f.size)}</small></div>`).join('')}
            </div>
        `).join('');
        
        document.getElementById('filesByLanguageModal').style.display = 'flex';
    }
    
    async viewNotebookSummary() {
        const semester = this.getCurrentSemester();
        if (!semester) return;
        
        let html = `<div style="max-height:60vh; overflow-y:auto;">`;
        html += `<h3>📚 Semester: ${this.escape(semester.name)}</h3>`;
        
        if (semester.semesterNotebook) {
            html += `<div style="margin:1rem 0; padding:1rem; background:#ffe2f0; border-radius:20px;">
                        <strong>📓 Semester Notebook:</strong><br>${this.escape(semester.semesterNotebook)}
                     </div>`;
        }
        
        for (const subject of semester.subjects) {
            html += `<div style="margin:1rem 0; padding:0.5rem; border-left:4px solid #f472b6;">
                        <strong>📖 ${this.escape(subject.name)}</strong>`;
            if (subject.notebookNotes) {
                html += `<div style="margin-top:0.5rem; padding-left:1rem;">📝 ${this.escape(subject.notebookNotes)}</div>`;
            }
            html += `</div>`;
        }
        html += `</div>`;
        
        document.getElementById('modalBody').innerHTML = html;
        document.getElementById('modalTitle').textContent = '📓 All Notebooks Summary';
        document.getElementById('fileViewerModal').style.display = 'flex';
    }
    
    closeModals() {
        document.getElementById('fileViewerModal').style.display = 'none';
        document.getElementById('filesByLanguageModal').style.display = 'none';
        document.getElementById('timerModal').style.display = 'none';
    }
    
    // ==================== SEARCH METHODS ====================
    
    setupSearch() {
        const searchInput = document.getElementById('searchInput');
        if (!searchInput) return;
        
        searchInput.addEventListener('input', this.debounce(() => {
            this.performGlobalSearch(searchInput.value);
        }, 300));
    }
    
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
    
    performGlobalSearch(term) {
        if (!term.trim()) {
            this.renderSubjects();
            if (this.selectedSubjectId) this.renderFiles();
            return;
        }
        
        const lowerTerm = term.toLowerCase();
        const semester = this.getCurrentSemester();
        if (!semester) return;
        
        const matchingSubjects = semester.subjects.filter(sub => 
            sub.name.toLowerCase().includes(lowerTerm) ||
            (sub.overallSubjectNotes && sub.overallSubjectNotes.toLowerCase().includes(lowerTerm)) ||
            (sub.notebookNotes && sub.notebookNotes.toLowerCase().includes(lowerTerm)) ||
            sub.files.some(f => f.name.toLowerCase().includes(lowerTerm) || 
                               (f.summaryNotes && f.summaryNotes.toLowerCase().includes(lowerTerm)))
        );
        
        const container = document.getElementById('subjectsList');
        if (matchingSubjects.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:2rem;">🔍 No matching subjects found</div>';
            return;
        }
        
        container.innerHTML = matchingSubjects.map(sub => `
            <div class="subject-bubble ${this.selectedSubjectId === sub.id ? 'selected' : ''}" data-subject-id="${sub.id}">
                <div>
                    <span class="subject-name-cute">📖 ${this.escape(sub.name)}</span>
                    <span class="badge-completion">${sub.completion || 'Exam only'}</span>
                </div>
                <div class="subject-actions">
                    <button class="mini-btn edit" data-subject-id="${sub.id}" data-action="edit">✏️ Edit</button>
                    <button class="mini-btn danger" data-subject-id="${sub.id}" data-action="delete">🗑️ Delete</button>
                </div>
            </div>
        `).join('');
        
        document.querySelectorAll('.subject-bubble').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('mini-btn')) return;
                const subjectId = parseInt(el.dataset.subjectId);
                this.selectSubject(subjectId);
            });
        });
    }
    
    setupFileSearch() {
        const fileSearchInput = document.getElementById('fileSearchInput');
        if (!fileSearchInput) return;
        
        fileSearchInput.addEventListener('input', this.debounce(() => {
            this.performFileSearch(fileSearchInput.value);
        }, 300));
    }
    
    performFileSearch(searchTerm) {
        const sub = this.getSubject(this.selectedSubjectId);
        if (!sub || !sub.files) return;
        
        const container = document.getElementById('filesList');
        if (!container) return;
        
        const term = searchTerm.toLowerCase().trim();
        
        if (!term) {
            this.renderFiles();
            return;
        }
        
        const matchedFiles = [];
        sub.files.forEach((file, idx) => {
            const nameMatch = file.name.toLowerCase().includes(term);
            const notesMatch = file.summaryNotes && file.summaryNotes.toLowerCase().includes(term);
            if (nameMatch || notesMatch) {
                matchedFiles.push({ file, idx, nameMatch, notesMatch });
            }
        });
        
        if (matchedFiles.length === 0) {
            container.innerHTML = `<div style="text-align:center; padding:2rem;">🔍 No files matching "${this.escape(term)}" found</div>`;
            return;
        }
        
        // Render with temporary highlight spans (not saved)
        container.innerHTML = matchedFiles.map(({ file, idx, nameMatch, notesMatch }) => {
            let displayName = this.escape(file.name);
            // CRITICAL FIX: Use the original plain text for the textarea value
            let displayNotes = file.summaryNotes ? this.escape(file.summaryNotes) : '';
            let displayNotesWithHighlight = displayNotes;
            
            if (nameMatch) {
                const regex = new RegExp(`(${this.escapeRegExp(term)})`, 'gi');
                displayName = displayName.replace(regex, '<span class="search-highlight">$1</span>');
            }
            if (notesMatch && displayNotes) {
                const regex = new RegExp(`(${this.escapeRegExp(term)})`, 'gi');
                displayNotesWithHighlight = displayNotes.replace(regex, '<span class="search-highlight">$1</span>');
            }
            
            return `<div class="file-card file-match-highlight">
                <div><i class="fas fa-paperclip"></i> ${displayName} <span style="background:#f0e6ff; border-radius:30px; padding:0.1rem 0.5rem;">${this.detectLanguage(file.name)}</span> <small>${this.formatSize(file.size)}</small></div>
                <textarea class="file-summary-input" data-idx="${idx}" rows="2" placeholder="add cute summary ..." style="width:100%; border-radius:40px; margin:5px 0; padding:0.5rem;">${displayNotes}</textarea>
                <div style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="pill-btn save-summary-btn" data-idx="${idx}">💾 Save summary</button>
                    <button class="pill-btn view-file-btn" data-idx="${idx}" style="background:#a5f3fc;">👁️ View in New Tab</button>
                    <button class="pill-btn delete-file-btn" data-idx="${idx}" style="background:#ffe0e0;">❌ Delete</button>
                </div>
            </div>`;
        }).join('');
        
        this.attachFileEventListeners();
    }
    
    escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    
    // ==================== TIMER METHODS ====================
    
    // ==================== TIMER METHODS ====================
    
    setupTimer() {
        const display = document.getElementById('timerDisplay');
        if (display) {
            this.updateTimerDisplay();
        }
        
        // Timer control buttons
        document.getElementById('timerStartBtn').onclick = () => this.startTimer();
        document.getElementById('timerPauseBtn').onclick = () => this.pauseTimer();
        document.getElementById('timerResetBtn').onclick = () => this.resetTimer();
        
        // Preset buttons
        document.getElementById('setPomodoroBtn').onclick = () => this.setTimer(25 * 60);
        document.getElementById('setShortBreakBtn').onclick = () => this.setTimer(5 * 60);
        document.getElementById('setLongBreakBtn').onclick = () => this.setTimer(15 * 60);
        
        // Custom time button
        document.getElementById('setCustomTimeBtn').onclick = () => this.setCustomTime();
        
        // Quick select buttons
        document.querySelectorAll('.quick-time').forEach(btn => {
            btn.onclick = () => {
                const minutes = parseInt(btn.dataset.minutes);
                if (!isNaN(minutes)) {
                    this.setTimer(minutes * 60);
                    this.showToast(`⏰ Timer set to ${minutes} minute${minutes !== 1 ? 's' : ''}`);
                }
            };
        });
        
        // Add enter key support for custom time inputs
        const customMinutes = document.getElementById('customMinutes');
        const customSeconds = document.getElementById('customSeconds');
        if (customMinutes) {
            customMinutes.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.setCustomTime();
            });
        }
        if (customSeconds) {
            customSeconds.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.setCustomTime();
            });
        }
    }

    setCustomTime() {
        const minutesInput = document.getElementById('customMinutes');
        const secondsInput = document.getElementById('customSeconds');
        
        let minutes = parseInt(minutesInput.value) || 0;
        let seconds = parseInt(secondsInput.value) || 0;
        
        // Validate inputs
        minutes = Math.max(0, Math.min(180, minutes)); // Max 3 hours
        seconds = Math.max(0, Math.min(59, seconds));
        
        const totalSeconds = (minutes * 60) + seconds;
        
        if (totalSeconds === 0) {
            this.showToast('Please enter a valid time (at least 1 second)');
            return;
        }
        
        this.setTimer(totalSeconds);
        
        // Update display to show what was set
        const mins = Math.floor(totalSeconds / 60);
        const secs = totalSeconds % 60;
        this.showToast(`⏰ Timer set to ${mins} min${mins !== 1 ? 's' : ''}${secs > 0 ? ` ${secs} sec` : ''}`);
    }

    updateTimerDisplay() {
        const display = document.getElementById('timerDisplay');
        if (display) {
            const minutes = Math.floor(this.timerSeconds / 60);
            const seconds = this.timerSeconds % 60;
            display.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            
            // Update the custom time inputs to match current timer (if not running)
            if (!this.timerRunning) {
                const customMinutes = document.getElementById('customMinutes');
                const customSeconds = document.getElementById('customSeconds');
                if (customMinutes && customSeconds) {
                    customMinutes.value = minutes;
                    customSeconds.value = seconds;
                }
            }
        }
    }

    startTimer() {
        if (this.timerRunning) return;
        
        // Add visual feedback
        const startBtn = document.getElementById('timerStartBtn');
        if (startBtn) {
            startBtn.style.transform = 'scale(0.95)';
            setTimeout(() => { startBtn.style.transform = ''; }, 200);
        }
        
        this.timerRunning = true;
        this.timerInterval = setInterval(() => {
            if (this.timerSeconds > 0) {
                this.timerSeconds--;
                this.updateTimerDisplay();
                
                // Optional: Update document title with remaining time
                const minutes = Math.floor(this.timerSeconds / 60);
                const seconds = this.timerSeconds % 60;
                document.title = `(${minutes}:${seconds.toString().padStart(2, '0')}) StudyBuddy`;
            } else {
                this.pauseTimer();
                this.timerComplete();
            }
        }, 1000);
    }

    timerComplete() {
        // Reset document title
        document.title = 'StudyBuddy · Cute Study Organizer';
        
        // Show notification
        this.showToast('⏰ Time is up! Great job focusing! 🎉');
        
        // Try to play sound (optional - won't error if fails)
        try {
            const audio = new Audio('https://www.soundjay.com/misc/sounds/bell-ringing-05.mp3');
            audio.play().catch(e => console.log('Audio not supported'));
        } catch(e) {}
        
        // Flash the modal or add visual effect
        const modal = document.getElementById('timerModal');
        if (modal) {
            modal.style.animation = 'none';
            modal.offsetHeight; // Trigger reflow
            modal.style.animation = null;
        }
    }

    pauseTimer() {
        this.timerRunning = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        // Reset document title
        document.title = 'StudyBuddy · Cute Study Organizer';
    }

    resetTimer() {
        this.pauseTimer();
        this.timerSeconds = 25 * 60;
        this.updateTimerDisplay();
        this.showToast('Timer reset to 25:00');
    }

    setTimer(seconds) {
        this.pauseTimer();
        this.timerSeconds = seconds;
        this.updateTimerDisplay();
        
        // Show what was set
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (remainingSeconds > 0) {
            this.showToast(`⏰ Timer set to ${minutes}:${remainingSeconds.toString().padStart(2, '0')}`);
        } else {
            this.showToast(`⏰ Timer set to ${minutes} minute${minutes !== 1 ? 's' : ''}`);
        }
    }
    
    updateTimerDisplay() {
        const display = document.getElementById('timerDisplay');
        if (display) {
            const minutes = Math.floor(this.timerSeconds / 60);
            const seconds = this.timerSeconds % 60;
            display.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    }
    
    startTimer() {
        if (this.timerRunning) return;
        this.timerRunning = true;
        this.timerInterval = setInterval(() => {
            if (this.timerSeconds > 0) {
                this.timerSeconds--;
                this.updateTimerDisplay();
            } else {
                this.pauseTimer();
                this.showToast('⏰ Time is up! Great job focusing! 🎉');
                new Audio('https://www.soundjay.com/misc/sounds/bell-ringing-05.mp3').play().catch(e => console.log('Audio not supported'));
            }
        }, 1000);
    }
    
    pauseTimer() {
        this.timerRunning = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }
    
    resetTimer() {
        this.pauseTimer();
        this.timerSeconds = 25 * 60;
        this.updateTimerDisplay();
    }
    
    setTimer(seconds) {
        this.pauseTimer();
        this.timerSeconds = seconds;
        this.updateTimerDisplay();
    }
    
    // ==================== UI METHODS ====================
    
    setupTabs() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tabId = btn.dataset.tab;
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active-tab'));
                btn.classList.add('active');
                document.getElementById(tabId).classList.add('active-tab');
            });
        });
    }
    
    toggleDarkMode() {
        document.body.classList.toggle('dark-mode');
        const isDark = document.body.classList.contains('dark-mode');
        localStorage.setItem('darkMode', isDark);
        const btn = document.getElementById('darkModeBtn');
        if (btn) {
            btn.innerHTML = isDark ? '<i class="fas fa-sun"></i> Light Mode' : '<i class="fas fa-moon"></i> Dark Mode';
        }
        
        // Force a re-render of current files to update their styles
        if (this.selectedSubjectId) {
            this.renderFiles();
        }
        
        this.showToast(isDark ? '🌙 Dark mode on' : '☀️ Light mode on');
    }
    
    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                const activeElement = document.activeElement;
                if (activeElement && activeElement.tagName === 'TEXTAREA') {
                    if (activeElement.id === 'subjectNotebook') this.saveSubjectNotebook();
                    else if (activeElement.id === 'semesterNotebook') this.saveSemesterNotebook();
                    else if (activeElement.classList?.contains('file-summary-input')) {
                        const btn = activeElement.parentElement?.querySelector('.save-summary-btn');
                        if (btn) btn.click();
                    }
                }
                this.showToast('💾 Saved!');
            }
            if (e.ctrlKey && e.key === 'f') {
                e.preventDefault();
                document.getElementById('searchInput')?.focus();
            }
            if (e.key === 'Escape') {
                this.closeModals();
            }
        });
    }
    
    updateStats() { 
        const totalSemesters = document.getElementById('totalSemesters'); 
        const totalSubjects = document.getElementById('totalSubjects'); 
        if (totalSemesters && this.data) { 
            totalSemesters.textContent = this.data.semesters.length; 
            const total = this.data.semesters.reduce((sum, s) => sum + s.subjects.length, 0); 
            totalSubjects.textContent = total; 
        } 
    }
    
    showToast(msg) { 
        const toast = document.getElementById('toast'); 
        if (!toast) return; 
        toast.textContent = msg + " 🧸"; 
        toast.classList.add('show'); 
        setTimeout(() => toast.classList.remove('show'), 2500); 
    }
    
    getCurrentSemester() { return this.data?.semesters.find(s => s.id === this.currentSemesterId); }
    getSubject(subjectId) { const sem = this.getCurrentSemester(); return sem?.subjects.find(s => s.id === subjectId); }
    
    detectLanguage(filename) { 
        const ext = filename.split('.').pop().toLowerCase(); 
        const map = { js:'JavaScript', py:'Python', java:'Java', cpp:'C++', html:'HTML', css:'CSS', pdf:'PDF', jpg:'Image', png:'Image', txt:'Text', md:'Markdown', ppt:'PPT', pptx:'PPT', json:'JSON', xml:'XML' }; 
        return map[ext] || '📄 File'; 
    }
    
    formatSize(bytes) { 
        if (!bytes) return '0 B'; 
        if (bytes < 1024) return bytes + ' B'; 
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'; 
        return (bytes / 1048576).toFixed(1) + ' MB'; 
    }
    
    escape(str) { 
        if (!str) return ''; 
        return String(str).replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'); 
    }
    
    // ==================== EVENT LISTENERS ====================
    
    attachEventListeners() {
        document.getElementById('semesterSelector')?.addEventListener('change', (e) => { 
            if (e.target.value) { 
                this.currentSemesterId = parseInt(e.target.value); 
                this.selectedSubjectId = null; 
                this.renderSubjects(); 
                this.loadSemesterNotebook(); 
                document.getElementById('subjectFilesArea').style.display = 'none'; 
                document.getElementById('selectedSubjectInfo').innerHTML = '<div style="padding:1rem;">🍬 pick a subject</div>'; 
            } 
        });
        
        document.getElementById('newSemesterBtn')?.addEventListener('click', () => { 
            const name = prompt('semester name?'); 
            if (name) this.addSemester(name); 
        });
        document.getElementById('deleteSemesterBtn')?.addEventListener('click', () => this.deleteCurrentSemester());
        document.getElementById('editSemesterBtn')?.addEventListener('click', () => this.editSemesterName());
        
        document.getElementById('addSubjectBtn')?.addEventListener('click', () => { 
            const name = document.getElementById('newSubjectName')?.value || ''; 
            const comp = document.getElementById('completionType')?.value || 'Exam only'; 
            this.addSubject(name, comp); 
        });
        
        const fileUpload = document.getElementById('fileUpload');
        const uploadZone = document.getElementById('uploadZone');
        if (fileUpload) fileUpload.addEventListener('change', (e) => { 
            if (e.target.files.length) this.handleFileUpload(e.target.files); 
            e.target.value = ''; 
        });
        if (uploadZone) { 
            uploadZone.addEventListener('click', () => fileUpload?.click()); 
            uploadZone.addEventListener('dragover', (e) => e.preventDefault()); 
            uploadZone.addEventListener('drop', (e) => { 
                e.preventDefault(); 
                const files = Array.from(e.dataTransfer.files); 
                if (files.length) this.handleFileUpload(files); 
            }); 
        }
        
        document.getElementById('saveSubjectNotesBtn')?.addEventListener('click', () => this.saveSubjectNotes());
        document.getElementById('saveSubjectNotebookBtn')?.addEventListener('click', () => this.saveSubjectNotebook());
        document.getElementById('saveSemesterNotebookBtn')?.addEventListener('click', () => this.saveSemesterNotebook());
        
        document.getElementById('generateSemesterSummaryBtn')?.addEventListener('click', () => this.generateSummary());
        document.getElementById('exportSummaryBtn')?.addEventListener('click', () => this.exportSummary());
        
        document.getElementById('exportDataBtn')?.addEventListener('click', () => this.exportToJSON());
        document.getElementById('importDataBtn')?.addEventListener('click', () => { 
            const inp = document.createElement('input'); 
            inp.type = 'file'; 
            inp.accept = '.json'; 
            inp.onchange = (e) => { 
                if (e.target.files.length) this.importFromJSON(e.target.files[0]); 
            }; 
            inp.click(); 
        });
        
        document.getElementById('openFilesViewBtn')?.addEventListener('click', () => this.openFilesByLanguage());
        document.getElementById('viewNotebookSummaryBtn')?.addEventListener('click', () => this.viewNotebookSummary());
        document.getElementById('closeModalBtn')?.addEventListener('click', () => this.closeModals());
        document.getElementById('closeLangModalBtn')?.addEventListener('click', () => this.closeModals());
        
        document.getElementById('darkModeBtn')?.addEventListener('click', () => this.toggleDarkMode());
        document.getElementById('timerBtn')?.addEventListener('click', () => {
            document.getElementById('timerModal').style.display = 'flex';
            this.setupTimer();
        });
        document.getElementById('closeTimerModalBtn')?.addEventListener('click', () => {
            document.getElementById('timerModal').style.display = 'none';
        });

        window.addEventListener('click', (e) => { 
            if (e.target.classList?.contains('modal-cute')) this.closeModals(); 
        });
        
        this.setupSearch();
        this.setupKeyboardShortcuts();
    }
}

window.addEventListener('DOMContentLoaded', () => { new StudyBuddy(); });
