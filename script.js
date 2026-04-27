class StudyBuddy {
    constructor() {
        this.db = null;
        this.data = null;
        this.currentSemesterId = null;
        this.selectedSubjectId = null;
        this.timerInterval = null;
        this.timerSeconds = 25 * 60;
        this.originalTimerSeconds = 25 * 60;
        this.timerRunning = false;
        this.currentDate = new Date();
        this.currentYear = this.currentDate.getFullYear();
        this.currentMonth = this.currentDate.getMonth();
        this.events = [];
        this.selectedEventForEdit = null;
        this.studyChart = null;
        this.init();
    }

    async init() {
        await this.initDB();
        this.attachEvents();
        this.setupTabs();
        if (this.data?.semesters.length) {
            this.currentSemesterId = this.data.semesters[0].id;
            this.renderSemesterSelector();
            this.renderSubjects();
            this.loadSemesterNotebook();
            await this.loadCalendarEvents();
            this.renderCalendar();
            this.renderUpcoming();
            this.renderProgressDashboard();
            this.updateStudyChart();
        } else {
            this.renderSemesterSelector();
            this.renderSubjects();
        }
        this.updateStats();
        const dark = localStorage.getItem('darkMode') === 'true';
        if (dark) document.body.classList.add('dark-mode');
        this.setupFileSearch();
        this.showToast('Ready');
    }

    initDB() {
        return new Promise(resolve => {
            const req = indexedDB.open('StudyBuddyDB', 7);
            req.onerror = () => { this.data = this.getDefault(); this.saveToLocal(); resolve(); };
            req.onsuccess = e => { this.db = e.target.result; this.loadData().then(resolve); };
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('appData')) db.createObjectStore('appData', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('files')) {
                    const store = db.createObjectStore('files', { keyPath: 'id' });
                    store.createIndex('subjectId', 'subjectId');
                }
                if (!db.objectStoreNames.contains('calendarEvents')) {
                    const eventStore = db.createObjectStore('calendarEvents', { keyPath: 'id' });
                    eventStore.createIndex('semesterId', 'semesterId');
                }
                if (!db.objectStoreNames.contains('studySessions')) {
                    const sessionStore = db.createObjectStore('studySessions', { keyPath: 'id' });
                    sessionStore.createIndex('date', 'date');
                    sessionStore.createIndex('subjectId', 'subjectId');
                }
            };
        });
    }

    async loadData() {
        if (!this.db) { this.data = this.getDefault(); return; }
        const tx = this.db.transaction('appData', 'readonly');
        const req = tx.objectStore('appData').get('mainData');
        return new Promise(resolve => {
            req.onsuccess = () => {
                this.data = req.result?.data || this.getDefault();
                for (const sem of this.data.semesters) {
                    for (const sub of sem.subjects) {
                        if (sub.progress === undefined) sub.progress = 0;
                    }
                }
                resolve();
            };
            req.onerror = () => { this.data = this.getDefault(); resolve(); };
        });
    }

    async saveData() {
        if (!this.db) { this.saveToLocal(); this.updateStats(); return; }
        const tx = this.db.transaction('appData', 'readwrite');
        tx.objectStore('appData').put({ id: 'mainData', data: this.data });
        return new Promise(r => tx.oncomplete = () => { this.updateStats(); r(); });
    }

    saveToLocal() { localStorage.setItem('studyBuddyBackup', JSON.stringify(this.data)); }

    async saveFileToDB(file, subjectId) {
        if (!this.db) return;
        const tx = this.db.transaction('files', 'readwrite');
        tx.objectStore('files').put({ ...file, subjectId });
        return new Promise(r => tx.oncomplete = r);
    }

    async getFileFromDB(id) {
        if (!this.db) return null;
        return new Promise(r => {
            const req = this.db.transaction('files', 'readonly').objectStore('files').get(id);
            req.onsuccess = () => r(req.result);
            req.onerror = () => r(null);
        });
    }

    async deleteFileFromDB(id) {
        if (!this.db) return;
        this.db.transaction('files', 'readwrite').objectStore('files').delete(id);
    }

    // ==================== STUDY SESSIONS ====================
    async logStudySession(durationMinutes, subjectId = null) {
        const session = {
            id: Date.now(),
            date: new Date().toISOString().split('T')[0],
            durationMinutes: durationMinutes,
            subjectId: subjectId || null,
            semesterId: this.currentSemesterId
        };
        const tx = this.db.transaction('studySessions', 'readwrite');
        tx.objectStore('studySessions').add(session);
        await new Promise(r => tx.oncomplete = r);
        this.updateStudyChart();
        this.showToast(`Logged ${durationMinutes} min study session`);
    }

    async getWeeklyStudyData() {
        if (!this.db) return [];
        const today = new Date();
        const last7 = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(today.getDate() - i);
            last7.push(d.toISOString().split('T')[0]);
        }
        const tx = this.db.transaction('studySessions', 'readonly');
        const store = tx.objectStore('studySessions');
        const all = await new Promise(r => {
            const req = store.getAll();
            req.onsuccess = () => r(req.result);
        });
        const filtered = all.filter(s => s.semesterId === this.currentSemesterId && last7.includes(s.date));
        const daily = {};
        for (const date of last7) daily[date] = 0;
        for (const s of filtered) daily[s.date] += s.durationMinutes;
        return last7.map(date => ({ date, minutes: daily[date] }));
    }

    async updateStudyChart() {
        const data = await this.getWeeklyStudyData();
        const labels = data.map(d => {
            const date = new Date(d.date);
            return date.toLocaleDateString(undefined, { weekday: 'short' });
        });
        const minutes = data.map(d => d.minutes);
        const totalWeek = minutes.reduce((a,b) => a+b, 0);
        document.getElementById('totalWeekMins').innerText = totalWeek;
        let streak = 0;
        for (let i = data.length-1; i >= 0; i--) {
            if (data[i].minutes > 0) streak++;
            else break;
        }
        document.getElementById('streakDays').innerText = streak;

        const ctx = document.getElementById('studyChart').getContext('2d');
        if (this.studyChart) this.studyChart.destroy();
        this.studyChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Study minutes',
                    data: minutes,
                    backgroundColor: '#3b82f6',
                    borderRadius: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: { legend: { position: 'top' } }
            }
        });
    }

    // ==================== CALENDAR ====================
    async loadCalendarEvents() {
        if (!this.db) return;
        const tx = this.db.transaction('calendarEvents', 'readonly');
        const index = tx.objectStore('calendarEvents').index('semesterId');
        const req = index.getAll(this.currentSemesterId);
        return new Promise(resolve => {
            req.onsuccess = () => { this.events = req.result || []; resolve(); };
            req.onerror = () => { this.events = []; resolve(); };
        });
    }

    async saveCalendarEvent(event) {
        if (!this.db) return;
        const tx = this.db.transaction('calendarEvents', 'readwrite');
        tx.objectStore('calendarEvents').put(event);
        return new Promise(r => tx.oncomplete = r);
    }

    async deleteCalendarEvent(id) {
        if (!this.db) return;
        const tx = this.db.transaction('calendarEvents', 'readwrite');
        tx.objectStore('calendarEvents').delete(id);
        return new Promise(r => tx.oncomplete = r);
    }

    async addOrUpdateEvent(eventData, eventId = null) {
        let event;
        if (eventId) {
            event = { ...eventData, id: eventId };
            const idx = this.events.findIndex(e => e.id === eventId);
            if (idx !== -1) this.events[idx] = event;
            else this.events.push(event);
            await this.saveCalendarEvent(event);
        } else {
            event = { ...eventData, id: Date.now() };
            this.events.push(event);
            await this.saveCalendarEvent(event);
        }
        this.renderCalendar();
        this.renderUpcoming();
        this.showToast('Event saved');
    }

    async deleteEvent(id) {
        if (confirm('Delete this event?')) {
            await this.deleteCalendarEvent(id);
            this.events = this.events.filter(e => e.id !== id);
            this.renderCalendar();
            this.renderUpcoming();
            this.showToast('Event deleted');
        }
    }

    renderCalendar() {
        const grid = document.getElementById('calendarGrid');
        if (!grid) return;
        const monthYear = document.getElementById('currentMonthYear');
        const firstDay = new Date(this.currentYear, this.currentMonth, 1);
        const startWeekday = firstDay.getDay();
        let startOffset = startWeekday === 0 ? 6 : startWeekday - 1;
        const daysInMonth = new Date(this.currentYear, this.currentMonth + 1, 0).getDate();
        monthYear.innerText = `${firstDay.toLocaleString('default', { month: 'long' })} ${this.currentYear}`;
        let gridHtml = '';
        for (let i = 0; i < startOffset; i++) gridHtml += '<div class="calendar-day empty"></div>';
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${this.currentYear}-${String(this.currentMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
            const hasEvent = this.events.some(ev => ev.date === dateStr);
            gridHtml += `<div class="calendar-day ${hasEvent ? 'has-event' : ''}" data-date="${dateStr}">${d}${hasEvent ? '<span class="event-dot"></span>' : ''}</div>`;
        }
        grid.innerHTML = gridHtml;
        document.querySelectorAll('.calendar-day:not(.empty)').forEach(day => {
            day.addEventListener('click', () => {
                const date = day.dataset.date;
                this.showDayEvents(date);
            });
        });
    }

    showDayEvents(date) {
        const dayEvents = this.events.filter(ev => ev.date === date);
        if (dayEvents.length === 0) {
            if (confirm(`No events on ${date}. Add one now?`)) {
                this.openEventModal(null, date);
            }
            return;
        }
        let modalHtml = `<h4>Events on ${date}</h4><ul style="list-style:none; padding:0;">`;
        for (const ev of dayEvents) {
            modalHtml += `
                <li style="background:#f8fafc; margin:8px 0; padding:8px; border-radius:16px;">
                    <strong>${this.escape(ev.title)}</strong> (${ev.type})<br>
                    <small>${this.escape(ev.notes || '')}</small><br>
                    <button class="edit-event-day" data-id="${ev.id}">Edit</button>
                    <button class="delete-event-day" data-id="${ev.id}">Delete</button>
                </li>
            `;
        }
        modalHtml += `</ul><button id="addEventOnDayBtn" class="btn-primary">+ Add new event</button>`;
        document.getElementById('modalBody').innerHTML = modalHtml;
        document.getElementById('modalTitle').innerText = `Events - ${date}`;
        document.getElementById('fileViewerModal').style.display = 'flex';

        document.querySelectorAll('.edit-event-day').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = parseInt(btn.dataset.id);
                const ev = this.events.find(e => e.id === id);
                if (ev) this.openEventModal(ev, null);
            });
        });
        document.querySelectorAll('.delete-event-day').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = parseInt(btn.dataset.id);
                await this.deleteEvent(id);
                document.getElementById('fileViewerModal').style.display = 'none';
            });
        });
        document.getElementById('addEventOnDayBtn')?.addEventListener('click', () => {
            document.getElementById('fileViewerModal').style.display = 'none';
            this.openEventModal(null, date);
        });
    }

    renderUpcoming() {
        const container = document.getElementById('upcomingList');
        if (!container) return;
        const today = new Date();
        today.setHours(0,0,0,0);
        const upcoming = this.events.filter(ev => new Date(ev.date) >= today)
            .sort((a,b) => new Date(a.date) - new Date(b.date))
            .slice(0, 10);
        if (upcoming.length === 0) {
            container.innerHTML = '<div class="placeholder-message">No upcoming events</div>';
            return;
        }
        container.innerHTML = upcoming.map(ev => {
            const dateObj = new Date(ev.date);
            const formatted = dateObj.toLocaleDateString();
            const typeClass = ev.type || 'other';
            return `<div class="upcoming-item ${typeClass}">
                        <div><strong>${this.escape(ev.title)}</strong><br><span class="upcoming-date">${formatted}</span></div>
                        <button class="edit-event-mini" data-id="${ev.id}"><i class="fas fa-edit"></i></button>
                    </div>`;
        }).join('');
        container.querySelectorAll('.edit-event-mini').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = parseInt(btn.dataset.id);
                const ev = this.events.find(e => e.id === id);
                if (ev) this.openEventModal(ev, null);
            });
        });
    }

    openEventModal(event = null, presetDate = null) {
        const modal = document.getElementById('eventModal');
        const titleInput = document.getElementById('eventTitle');
        const typeSelect = document.getElementById('eventType');
        const dateInput = document.getElementById('eventDate');
        const notesInput = document.getElementById('eventNotes');
        const deleteBtn = document.getElementById('deleteEventBtn');
        const modalTitle = document.getElementById('eventModalTitle');

        if (event) {
            modalTitle.innerText = 'Edit event';
            titleInput.value = event.title;
            typeSelect.value = event.type;
            dateInput.value = event.date;
            notesInput.value = event.notes || '';
            deleteBtn.style.display = 'block';
            this.selectedEventForEdit = event;
        } else {
            modalTitle.innerText = 'Add event';
            titleInput.value = '';
            typeSelect.value = 'exam';
            dateInput.value = presetDate || '';
            notesInput.value = '';
            deleteBtn.style.display = 'none';
            this.selectedEventForEdit = null;
        }
        modal.style.display = 'flex';
    }

    async saveEventFromModal() {
        const title = document.getElementById('eventTitle').value.trim();
        const type = document.getElementById('eventType').value;
        const date = document.getElementById('eventDate').value;
        const notes = document.getElementById('eventNotes').value;
        if (!title || !date) {
            this.showToast('Title and date are required');
            return;
        }
        if (this.selectedEventForEdit) {
            await this.addOrUpdateEvent({ title, type, date, notes, semesterId: this.currentSemesterId }, this.selectedEventForEdit.id);
        } else {
            await this.addOrUpdateEvent({ title, type, date, notes, semesterId: this.currentSemesterId });
        }
        document.getElementById('eventModal').style.display = 'none';
        this.selectedEventForEdit = null;
    }

    async changeMonth(delta) {
        let newMonth = this.currentMonth + delta;
        let newYear = this.currentYear;
        if (newMonth < 0) { newMonth = 11; newYear--; }
        if (newMonth > 11) { newMonth = 0; newYear++; }
        this.currentMonth = newMonth;
        this.currentYear = newYear;
        this.renderCalendar();
    }

    // ==================== PROGRESS DASHBOARD ====================
    renderProgressDashboard() {
        const container = document.getElementById('subjectProgressList');
        const semester = this.getCurrentSemester();
        if (!container || !semester) return;
        if (!semester.subjects.length) {
            container.innerHTML = '<div class="placeholder-message">No subjects yet</div>';
            return;
        }
        container.innerHTML = semester.subjects.map(sub => `
            <div class="progress-item" data-subj-id="${sub.id}">
                <div class="progress-header">
                    <span>${this.escape(sub.name)}</span>
                    <span>${sub.progress || 0}%</span>
                </div>
                <div class="progress-bar-bg">
                    <div class="progress-fill" style="width: ${sub.progress || 0}%"></div>
                </div>
                <div class="progress-controls">
                    <button class="progress-dec" data-id="${sub.id}">-10</button>
                    <input type="number" class="progress-input" data-id="${sub.id}" value="${sub.progress || 0}" min="0" max="100" step="5">
                    <button class="progress-inc" data-id="${sub.id}">+10</button>
                </div>
            </div>
        `).join('');
        container.querySelectorAll('.progress-dec').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = parseInt(btn.dataset.id);
                const sub = this.getSubject(id);
                if (sub) {
                    let newVal = (sub.progress || 0) - 10;
                    if (newVal < 0) newVal = 0;
                    sub.progress = newVal;
                    await this.saveData();
                    this.renderProgressDashboard();
                    this.renderSubjects();
                }
            });
        });
        container.querySelectorAll('.progress-inc').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = parseInt(btn.dataset.id);
                const sub = this.getSubject(id);
                if (sub) {
                    let newVal = (sub.progress || 0) + 10;
                    if (newVal > 100) newVal = 100;
                    sub.progress = newVal;
                    await this.saveData();
                    this.renderProgressDashboard();
                    this.renderSubjects();
                }
            });
        });
        container.querySelectorAll('.progress-input').forEach(inp => {
            inp.addEventListener('change', async (e) => {
                const id = parseInt(inp.dataset.id);
                const sub = this.getSubject(id);
                if (sub) {
                    let val = parseInt(inp.value);
                    if (isNaN(val)) val = 0;
                    if (val < 0) val = 0;
                    if (val > 100) val = 100;
                    sub.progress = val;
                    await this.saveData();
                    this.renderProgressDashboard();
                    this.renderSubjects();
                }
            });
        });
    }

    // ==================== SUBJECTS ====================
    getDefault() {
        const now = Date.now();
        return {
            semesters: [{
                id: now,
                name: "Spring 2025",
                semesterNotebook: "Semester goals: consistency, projects, revision.",
                subjects: [
                    { id: now+1, name: "UX Design", completion: "Project only", progress: 0, files: [], overallSubjectNotes: "", notebookNotes: "" },
                    { id: now+2, name: "Creative Coding", completion: "Exam + Project", progress: 0, files: [], overallSubjectNotes: "", notebookNotes: "" }
                ]
            }]
        };
    }

    renderSemesterSelector() {
        const sel = document.getElementById('semesterSelector');
        if (!sel) return;
        sel.innerHTML = this.data.semesters.map(s => `<option value="${s.id}" ${this.currentSemesterId === s.id ? 'selected' : ''}>📘 ${this.escape(s.name)}</option>`).join('');
    }

    renderSubjects() {
        const container = document.getElementById('subjectsList');
        const semester = this.getCurrentSemester();
        if (!container || !semester) return;
        if (!semester.subjects.length) {
            container.innerHTML = '<div class="placeholder-message">No subjects — add your first</div>';
            return;
        }
        const sortedSubjects = [...semester.subjects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        container.innerHTML = sortedSubjects.map(sub => `
            <div class="subject-item ${this.selectedSubjectId === sub.id ? 'selected' : ''}" data-id="${sub.id}">
                <div><span class="subject-name">📖 ${this.escape(sub.name)}</span><span class="subject-badge">${sub.completion || 'Exam only'}</span></div>
                <div class="subject-actions"><button class="edit-subj">Edit</button><button class="del-subj">Delete</button></div>
            </div>
        `).join('');
        container.querySelectorAll('.subject-item').forEach(el => {
            const id = parseInt(el.dataset.id);
            el.addEventListener('click', (e) => { if (!e.target.classList.contains('edit-subj') && !e.target.classList.contains('del-subj')) this.selectSubject(id); });
            el.querySelector('.edit-subj')?.addEventListener('click', (e) => { e.stopPropagation(); this.editSubject(id); });
            el.querySelector('.del-subj')?.addEventListener('click', (e) => { e.stopPropagation(); this.deleteSubject(id); });
        });
    }

    selectSubject(id) {
        this.selectedSubjectId = id;
        this.renderSubjects();
        const sub = this.getSubject(id);
        if (sub) {
            document.getElementById('selectedSubjectInfo').innerHTML = `<div style="background:#eef2ff; border-radius:28px; padding:0.5rem; text-align:center;">${this.escape(sub.name)} · ${sub.completion}</div>`;
            document.getElementById('subjectFilesArea').style.display = 'block';
            document.getElementById('subjectOverallNotes').value = sub.overallSubjectNotes || '';
            document.getElementById('subjectNotebook').value = sub.notebookNotes || '';
            this.renderFiles();
        }
    }

    renderFiles() {
        const sub = this.getSubject(this.selectedSubjectId);
        const container = document.getElementById('filesList');
        if (!container || !sub) return;
        if (!sub.files?.length) { container.innerHTML = '<div class="placeholder-message">No files yet — upload materials</div>'; return; }
        container.innerHTML = sub.files.map((f, idx) => `
            <div class="file-card">
                <div><i class="fas fa-paperclip"></i> ${this.escape(f.name)} <span style="background:#f1f5f9; border-radius:20px; padding:0.1rem 0.5rem;">${this.detectLang(f.name)}</span> <small>${this.formatSize(f.size)}</small></div>
                <textarea class="summary-inp" data-idx="${idx}" rows="2" placeholder="Add summary...">${this.escape(f.summaryNotes || '')}</textarea>
                <div style="display:flex; gap:6px; margin-top:6px;"><button class="save-summary" data-idx="${idx}">Save</button><button class="view-file" data-idx="${idx}">View</button><button class="del-file" data-idx="${idx}">Delete</button></div>
            </div>
        `).join('');
        this.attachFileListeners();
    }

    attachFileListeners() {
        const con = document.getElementById('filesList');
        if (!con) return;
        const sub = this.getSubject(this.selectedSubjectId);
        if (!sub) return;
        con.querySelectorAll('.save-summary').forEach(btn => btn.onclick = async () => {
            const idx = parseInt(btn.dataset.idx);
            const ta = con.querySelector(`.summary-inp[data-idx="${idx}"]`);
            if (ta && sub.files[idx]) {
                sub.files[idx].summaryNotes = ta.value.replace(/<[^>]*>/g, '');
                await this.saveData();
                this.renderFiles();
                this.showToast('Summary saved');
            }
        });
        con.querySelectorAll('.view-file').forEach(btn => btn.onclick = async () => {
            const idx = parseInt(btn.dataset.idx);
            await this.openFile(sub.files[idx]);
        });
        con.querySelectorAll('.del-file').forEach(btn => btn.onclick = async () => {
            if (confirm('Delete file?')) {
                const idx = parseInt(btn.dataset.idx);
                await this.deleteFileFromDB(sub.files[idx].id);
                sub.files.splice(idx, 1);
                await this.saveData();
                this.renderFiles();
                this.showToast('File removed');
            }
        });
    }

    async openFile(file) {
        const data = await this.getFileFromDB(file.id);
        if (data?.data) {
            const blob = this.dataURLToBlob(data.data);
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 3000);
        } else this.showToast('File data missing');
    }

    dataURLToBlob(dataURL) {
        const arr = dataURL.split(',');
        const mime = arr[0].match(/:(.*?);/)?.[1] || 'application/octet-stream';
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8 = new Uint8Array(n);
        while (n--) u8[n] = bstr.charCodeAt(n);
        return new Blob([u8], { type: mime });
    }

    addSubject(name, type) {
        if (!name.trim()) return;
        const sem = this.getCurrentSemester();
        sem.subjects.push({ id: Date.now(), name: name.trim(), completion: type, progress: 0, files: [], overallSubjectNotes: '', notebookNotes: '' });
        this.saveData();
        this.renderSubjects();
        this.renderProgressDashboard();
        document.getElementById('newSubjectName').value = '';
        this.showToast(`Added ${name}`);
    }

    async editSubject(id) {
        const sub = this.getSubject(id);
        const newName = prompt('Subject name:', sub.name);
        if (newName?.trim()) { sub.name = newName.trim(); await this.saveData(); this.renderSubjects(); this.renderProgressDashboard(); if (this.selectedSubjectId === id) this.selectSubject(id); }
    }

    async deleteSubject(id) {
        if (!confirm('Permanently delete subject and all its files?')) return;
        const sub = this.getSubject(id);
        for (const f of sub.files) await this.deleteFileFromDB(f.id);
        const sem = this.getCurrentSemester();
        sem.subjects = sem.subjects.filter(s => s.id !== id);
        if (this.selectedSubjectId === id) {
            this.selectedSubjectId = null;
            document.getElementById('subjectFilesArea').style.display = 'none';
            document.getElementById('selectedSubjectInfo').innerHTML = '<div class="placeholder-message">Select a subject</div>';
        }
        await this.saveData();
        this.renderSubjects();
        this.renderProgressDashboard();
    }

    saveSubjectNotes() { const sub = this.getSubject(this.selectedSubjectId); if (sub) { sub.overallSubjectNotes = document.getElementById('subjectOverallNotes').value; this.saveData(); this.showToast('Notes saved'); } }
    saveSubjectNotebook() { const sub = this.getSubject(this.selectedSubjectId); if (sub) { sub.notebookNotes = document.getElementById('subjectNotebook').value; this.saveData(); this.showToast('Notebook saved'); } }
    loadSemesterNotebook() { const sem = this.getCurrentSemester(); if (sem) document.getElementById('semesterNotebook').value = sem.semesterNotebook || ''; }
    saveSemesterNotebook() { const sem = this.getCurrentSemester(); if (sem) { sem.semesterNotebook = document.getElementById('semesterNotebook').value; this.saveData(); this.showToast('Semester notebook saved'); } }

    addSemester(name) {
        this.data.semesters.push({ id: Date.now(), name, semesterNotebook: '', subjects: [] });
        this.saveData();
        this.currentSemesterId = this.data.semesters[this.data.semesters.length-1].id;
        this.selectedSubjectId = null;
        this.renderSemesterSelector();
        this.renderSubjects();
        this.loadSemesterNotebook();
        document.getElementById('subjectFilesArea').style.display = 'none';
        this.loadCalendarEvents().then(() => { this.renderCalendar(); this.renderUpcoming(); });
    }

    async deleteCurrentSemester() {
        if (this.data.semesters.length <= 1) { this.showToast('Cannot delete last semester'); return; }
        const sem = this.getCurrentSemester();
        if (confirm(`Delete "${sem.name}" semester?`)) {
            for (const sub of sem.subjects) for (const f of sub.files) await this.deleteFileFromDB(f.id);
            const eventsToDelete = this.events.map(e => e.id);
            for (const id of eventsToDelete) await this.deleteCalendarEvent(id);
            const tx = this.db.transaction('studySessions', 'readwrite');
            const sessions = await new Promise(r => { const req = tx.objectStore('studySessions').index('semesterId').getAll(this.currentSemesterId); req.onsuccess = () => r(req.result); });
            for (const s of sessions) await new Promise(r => { const req = tx.objectStore('studySessions').delete(s.id); req.onsuccess = r; });
            this.data.semesters = this.data.semesters.filter(s => s.id !== this.currentSemesterId);
            this.currentSemesterId = this.data.semesters[0].id;
            this.selectedSubjectId = null;
            await this.saveData();
            await this.loadCalendarEvents();
            this.renderSemesterSelector();
            this.renderSubjects();
            this.loadSemesterNotebook();
            document.getElementById('subjectFilesArea').style.display = 'none';
            this.renderCalendar();
            this.renderUpcoming();
            this.renderProgressDashboard();
            this.updateStudyChart();
            this.showToast('Semester deleted');
        }
    }

    editSemesterName() {
        const sem = this.getCurrentSemester();
        const newName = prompt('Rename semester:', sem.name);
        if (newName?.trim()) { sem.name = newName.trim(); this.saveData(); this.renderSemesterSelector(); this.showToast('Renamed'); }
    }

    async handleFileUpload(files) {
        const sub = this.getSubject(this.selectedSubjectId);
        if (!sub) { this.showToast('Select a subject first'); return; }
        for (const file of files) {
            const id = Date.now() + Math.random();
            const fileMeta = { id, name: file.name, size: file.size, type: file.type, summaryNotes: '', uploadedAt: new Date().toISOString() };
            const reader = new FileReader();
            reader.onload = async (e) => {
                fileMeta.data = e.target.result;
                await this.saveFileToDB(fileMeta, sub.id);
                sub.files.push({ id, name: file.name, size: file.size, type: file.type, summaryNotes: '', uploadedAt: new Date().toISOString() });
                await this.saveData();
                this.renderFiles();
                this.showToast(`Uploaded ${file.name}`);
            };
            reader.readAsDataURL(file);
        }
    }

    generateSummary() {
        const sem = this.getCurrentSemester();
        if (!sem) return;
        let txt = `SEMESTER SUMMARY: ${sem.name}\n\n`;
        if (sem.semesterNotebook) txt += `📓 Semester notebook:\n${sem.semesterNotebook}\n\n`;
        for (const sub of sem.subjects) {
            txt += `📖 ${sub.name} (${sub.completion}) — Progress: ${sub.progress || 0}%\n`;
            if (sub.overallSubjectNotes) txt += `Notes: ${sub.overallSubjectNotes}\n`;
            if (sub.notebookNotes) txt += `Notebook: ${sub.notebookNotes}\n`;
            if (sub.files?.length) {
                txt += `Files (${sub.files.length}):\n`;
                sub.files.forEach(f => { txt += `  • ${f.name}${f.summaryNotes ? ` → ${f.summaryNotes}` : ''}\n`; });
            }
            txt += `\n`;
        }
        if (this.events.length) {
            txt += `\n📅 DEADLINES & EVENTS:\n`;
            this.events.forEach(ev => txt += `  • ${ev.title} (${ev.date}) - ${ev.type}\n`);
        }
        document.getElementById('semesterSummary').innerHTML = `<pre style="white-space:pre-wrap;">${this.escape(txt)}</pre>`;
        this.showToast('Summary generated');
    }

    exportSummary() {
        const pre = document.getElementById('semesterSummary').innerText;
        const blob = new Blob([pre], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `summary_${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    setupTimer() {
        const displayEl = document.getElementById('timerDisplay');
        const startBtn = document.getElementById('timerStartBtn');
        const pauseBtn = document.getElementById('timerPauseBtn');
        const resetBtn = document.getElementById('timerResetBtn');
        const customBtn = document.getElementById('setCustomTimeBtn');
        const quickBtns = document.querySelectorAll('.quick-time');

        const updateDisplay = () => {
            const mins = Math.floor(this.timerSeconds / 60);
            const secs = this.timerSeconds % 60;
            displayEl.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        };

        const stopTimer = () => {
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            this.timerRunning = false;
        };

        const startTimer = () => {
            if (this.timerRunning) return;
            this.timerRunning = true;
            this.timerInterval = setInterval(() => {
                if (this.timerSeconds > 0) {
                    this.timerSeconds--;
                    updateDisplay();
                } else {
                    stopTimer();
                    const durationMins = Math.floor(this.originalTimerSeconds / 60);
                    if (durationMins > 0) {
                        this.logStudySession(durationMins, this.selectedSubjectId);
                    }
                    this.showToast('Time is up! Session logged.');
                }
            }, 1000);
        };

        const setTimerAndStore = (seconds) => {
            stopTimer();
            this.timerSeconds = seconds;
            this.originalTimerSeconds = seconds;
            updateDisplay();
        };

        const newStart = startBtn.cloneNode(true);
        startBtn.parentNode.replaceChild(newStart, startBtn);
        const newPause = pauseBtn.cloneNode(true);
        pauseBtn.parentNode.replaceChild(newPause, pauseBtn);
        const newReset = resetBtn.cloneNode(true);
        resetBtn.parentNode.replaceChild(newReset, resetBtn);
        const newCustom = customBtn.cloneNode(true);
        customBtn.parentNode.replaceChild(newCustom, customBtn);

        newStart.addEventListener('click', startTimer);
        newPause.addEventListener('click', stopTimer);
        newReset.addEventListener('click', () => setTimerAndStore(25 * 60));
        newCustom.addEventListener('click', () => {
            let mins = parseInt(document.getElementById('customMinutes').value) || 0;
            let secs = parseInt(document.getElementById('customSeconds').value) || 0;
            if (mins === 0 && secs === 0) return;
            setTimerAndStore(mins * 60 + secs);
        });

        quickBtns.forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => {
                const minutes = parseInt(newBtn.dataset.minutes);
                if (!isNaN(minutes)) setTimerAndStore(minutes * 60);
            });
        });

        setTimerAndStore(25 * 60);
    }

    viewNotebookSummary() {
        const sem = this.getCurrentSemester();
        let html = `<div><strong>${this.escape(sem.name)}</strong><br>`;
        if (sem.semesterNotebook) html += `<p><em>Semester notes:</em><br>${this.escape(sem.semesterNotebook)}</p>`;
        sem.subjects.forEach(s => { html += `<hr><b>${this.escape(s.name)}</b><br>${this.escape(s.notebookNotes || 'No notes')}`; });
        html += `</div>`;
        document.getElementById('modalBody').innerHTML = html;
        document.getElementById('modalTitle').innerText = 'Notebook summary';
        document.getElementById('fileViewerModal').style.display = 'flex';
    }

    async openFilesByLanguage() { this.showToast('Browse files from subject studio'); }

    attachEvents() {
        document.getElementById('semesterSelector')?.addEventListener('change', async (e) => {
            this.currentSemesterId = parseInt(e.target.value);
            this.selectedSubjectId = null;
            this.renderSubjects();
            this.loadSemesterNotebook();
            document.getElementById('subjectFilesArea').style.display = 'none';
            document.getElementById('selectedSubjectInfo').innerHTML = '<div class="placeholder-message">Select a subject</div>';
            await this.loadCalendarEvents();
            this.renderCalendar();
            this.renderUpcoming();
            this.renderProgressDashboard();
            this.updateStudyChart();
        });
        document.getElementById('newSemesterBtn')?.addEventListener('click', () => { let n = prompt('Semester name:'); if (n) this.addSemester(n); });
        document.getElementById('deleteSemesterBtn')?.addEventListener('click', () => this.deleteCurrentSemester());
        document.getElementById('editSemesterBtn')?.addEventListener('click', () => this.editSemesterName());
        document.getElementById('addSubjectBtn')?.addEventListener('click', () => { this.addSubject(document.getElementById('newSubjectName').value, document.getElementById('completionType').value); });
        const upZone = document.getElementById('uploadZone'), upFile = document.getElementById('fileUpload');
        upZone?.addEventListener('click', () => upFile.click());
        upZone?.addEventListener('dragover', e => e.preventDefault());
        upZone?.addEventListener('drop', e => { e.preventDefault(); this.handleFileUpload(Array.from(e.dataTransfer.files)); });
        upFile?.addEventListener('change', e => { if(e.target.files.length) this.handleFileUpload(e.target.files); e.target.value = ''; });
        document.getElementById('saveSubjectNotesBtn')?.addEventListener('click', () => this.saveSubjectNotes());
        document.getElementById('saveSubjectNotebookBtn')?.addEventListener('click', () => this.saveSubjectNotebook());
        document.getElementById('saveSemesterNotebookBtn')?.addEventListener('click', () => this.saveSemesterNotebook());
        document.getElementById('generateSemesterSummaryBtn')?.addEventListener('click', () => this.generateSummary());
        document.getElementById('exportSummaryBtn')?.addEventListener('click', () => this.exportSummary());
        document.getElementById('exportDataBtn')?.addEventListener('click', () => { const backup = { data: this.data, exportDate: new Date() }; const blob = new Blob([JSON.stringify(backup)], {type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`studyhub_backup.json`; a.click(); URL.revokeObjectURL(a.href); this.showToast('Backup saved'); });
        document.getElementById('importDataBtn')?.addEventListener('click', () => { const inp = document.createElement('input'); inp.type='file'; inp.accept='.json'; inp.onchange = async e => { const file = e.target.files[0]; const reader = new FileReader(); reader.onload = async ev => { try { const imported = JSON.parse(ev.target.result); if(imported.data?.semesters && confirm('Replace all data?')){ this.data = imported.data; await this.saveData(); this.currentSemesterId = this.data.semesters[0]?.id || null; this.selectedSubjectId = null; this.renderSemesterSelector(); this.renderSubjects(); this.loadSemesterNotebook(); document.getElementById('subjectFilesArea').style.display = 'none'; await this.loadCalendarEvents(); this.renderCalendar(); this.renderUpcoming(); this.renderProgressDashboard(); this.updateStudyChart(); this.showToast('Restored'); } else this.showToast('Invalid backup'); } catch(err){ this.showToast('Error'); } }; reader.readAsText(file); }; inp.click(); });
        document.getElementById('openFilesViewBtn')?.addEventListener('click', () => this.openFilesByLanguage());
        document.getElementById('viewNotebookSummaryBtn')?.addEventListener('click', () => this.viewNotebookSummary());
        document.getElementById('darkModeBtn')?.addEventListener('click', () => { document.body.classList.toggle('dark-mode'); localStorage.setItem('darkMode', document.body.classList.contains('dark-mode')); const btn = document.getElementById('darkModeBtn'); btn.innerHTML = document.body.classList.contains('dark-mode') ? '<i class="fas fa-sun"></i> Light' : '<i class="fas fa-moon"></i> Dark'; });
        document.getElementById('timerBtn')?.addEventListener('click', () => { document.getElementById('timerModal').style.display = 'flex'; this.setupTimer(); });
        document.getElementById('closeTimerModalBtn')?.addEventListener('click', () => document.getElementById('timerModal').style.display = 'none');
        document.getElementById('closeModalBtn')?.addEventListener('click', () => document.getElementById('fileViewerModal').style.display = 'none');
        document.getElementById('closeLangModalBtn')?.addEventListener('click', () => document.getElementById('filesByLanguageModal').style.display = 'none');
        document.getElementById('closeEventModalBtn')?.addEventListener('click', () => document.getElementById('eventModal').style.display = 'none');
        document.getElementById('saveEventBtn')?.addEventListener('click', () => this.saveEventFromModal());
        document.getElementById('deleteEventBtn')?.addEventListener('click', async () => {
            if (this.selectedEventForEdit) {
                await this.deleteEvent(this.selectedEventForEdit.id);
                document.getElementById('eventModal').style.display = 'none';
                this.selectedEventForEdit = null;
            }
        });
        document.getElementById('prevMonthBtn')?.addEventListener('click', () => this.changeMonth(-1));
        document.getElementById('nextMonthBtn')?.addEventListener('click', () => this.changeMonth(1));
        window.addEventListener('click', e => { if(e.target.classList?.contains('modal')) e.target.style.display = 'none'; });
        const search = document.getElementById('searchInput');
        search?.addEventListener('input', this.debounce(() => {
            const term = search.value.toLowerCase();
            const sem = this.getCurrentSemester();
            if (!term) { this.renderSubjects(); return; }
            const filtered = sem.subjects.filter(s => s.name.toLowerCase().includes(term) || s.files.some(f=>f.name.toLowerCase().includes(term)));
            const sorted = [...filtered].sort((a,b) => a.name.localeCompare(b.name));
            const container = document.getElementById('subjectsList');
            container.innerHTML = sorted.map(sub => `<div class="subject-item" data-id="${sub.id}"><div>📖 ${this.escape(sub.name)}<span class="subject-badge">${sub.completion}</span></div><div class="subject-actions"><button class="edit-subj">Edit</button><button class="del-subj">Delete</button></div></div>`).join('');
            this.renderSubjects();
        }, 300));
        this.setupFileSearch();
    }

    setupFileSearch() {
        const inp = document.getElementById('fileSearchInput');
        inp?.addEventListener('input', this.debounce(() => {
            const term = inp.value.toLowerCase();
            const sub = this.getSubject(this.selectedSubjectId);
            if (!sub) return;
            if (!term) { this.renderFiles(); return; }
            const filtered = sub.files.filter(f => f.name.toLowerCase().includes(term) || (f.summaryNotes && f.summaryNotes.toLowerCase().includes(term)));
            const container = document.getElementById('filesList');
            container.innerHTML = filtered.map((f, idx) => `<div class="file-card"><div>📎 ${this.escape(f.name)} <small>${this.formatSize(f.size)}</small></div><textarea class="summary-inp" data-idx="${idx}" rows="2">${this.escape(f.summaryNotes||'')}</textarea><div><button class="save-summary" data-idx="${idx}">Save</button><button class="view-file" data-idx="${idx}">View</button></div></div>`).join('');
            this.attachFileListeners();
        }, 250));
    }

    setupTabs() {
        document.querySelectorAll('.tab').forEach(btn => {
            btn.addEventListener('click', () => {
                const tabId = btn.dataset.tab;
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById(tabId).classList.add('active');
            });
        });
    }

    updateStats() {
        const semSpan = document.getElementById('totalSemesters');
        const subSpan = document.getElementById('totalSubjects');
        if (semSpan) semSpan.innerText = this.data.semesters.length;
        if (subSpan) subSpan.innerText = this.data.semesters.reduce((a,b) => a + b.subjects.length, 0);
    }

    showToast(msg) { const t = document.getElementById('toast'); t.innerText = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2000); }
    getCurrentSemester() { return this.data?.semesters.find(s => s.id === this.currentSemesterId); }
    getSubject(id) { return this.getCurrentSemester()?.subjects.find(s => s.id === id); }
    detectLang(fn) { const ext = fn.split('.').pop().toLowerCase(); const map = { js:'JS', py:'Python', pdf:'PDF', ppt:'PPT', txt:'Text', md:'MD', json:'JSON', jpg:'Image', png:'Image' }; return map[ext] || 'File'; }
    formatSize(b) { if(!b) return '0 B'; if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(1)+' KB'; return (b/1048576).toFixed(1)+' MB'; }
    escape(str) { if(!str) return ''; return String(str).replace(/[&<>]/g, m => m==='&'?'&amp;':m==='<'?'&lt;':'&gt;'); }
    debounce(fn, delay) { let t; return function(...args){ clearTimeout(t); t = setTimeout(() => fn(...args), delay); }; }
}

new StudyBuddy();
