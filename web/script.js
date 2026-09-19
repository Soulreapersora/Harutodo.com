(() => {
    'use strict';

    /* ======================================================================
       Haru To-Do: app logic
       `tasks` is the single source of truth. The page is only a view of it,
       and every change is saved straight away, so a deleted task stays deleted.
       (Rain lives in rain.js.)
       ====================================================================== */

    const STORAGE_KEY = 'haru-todos';
    const FILTER_KEY = 'haru-filter';
    const FILTERS = ['all', 'active', 'done'];
    const REMOVE_MS = 300;   // matches the task-out animation in style.css
    const UNDO_MS = 6000;    // how long the Undo message stays
    const MAX_LEN = 120;

    const EMPTY_TEXT = {
        all: 'Nothing here yet. Add your first task above.',
        active: 'No active tasks. Everything is done.',
        done: 'No completed tasks yet.',
    };

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    /* ---------- Elements ---------- */

    const $ = (selector) => document.querySelector(selector);

    const dom = {
        form: $('#task-form'),
        input: $('#taskInput'),
        list: $('#task-list'),
        template: $('#task-template'),
        empty: $('#empty-state'),
        emptyText: $('#empty-text'),
        filterBar: $('.filters'),
        filterBtns: [...document.querySelectorAll('.filter-btn')],
        left: $('#items-left'),
        clear: $('#clear-done'),
        toast: $('#toast'),
        toastText: $('#toast-text'),
        undo: $('#undo-btn'),
        date: $('#app-date'),
        pWrap: $('.progress-wrap'),
        pTrack: $('.progress-track'),
        pFill: $('#progress-fill'),
        pPercent: $('#progress-percent'),
        pLabel: $('#progress-label'),
    };

    // If index.html is an older version, say so clearly instead of failing silently
    const missing = Object.entries(dom)
        .filter(([key, value]) => key !== 'date' && (Array.isArray(value) ? value.length === 0 : !value))
        .map(([key]) => key);

    if (missing.length) {
        console.error('[Haru To-Do] index.html is out of date. Missing elements:', missing.join(', '));
        return;
    }

    /* ---------- State + storage ---------- */

    let tasks = loadTasks();
    let filter = loadFilter();
    let pendingUndo = null;   // { items: [{ task, index }] } from the last delete
    let undoTimer = null;
    const rows = new Map();   // task id -> its <li>

    function makeId() {
        return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function loadTasks() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
            if (!Array.isArray(saved)) return [];
            return saved
                .filter((t) => t && typeof t.text === 'string' && t.text.trim())
                .map((t) => ({
                    id: t.id || makeId(),
                    text: t.text.trim().slice(0, MAX_LEN),
                    done: Boolean(t.done ?? t.completed), // `completed` = older saved format
                }));
        } catch {
            return [];
        }
    }

    function saveTasks() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
        } catch {
            /* storage blocked or full: the app still works, it just won't persist */
        }
    }

    function loadFilter() {
        try {
            const saved = localStorage.getItem(FILTER_KEY);
            return FILTERS.includes(saved) ? saved : 'all';
        } catch {
            return 'all';
        }
    }

    function saveFilter() {
        try {
            localStorage.setItem(FILTER_KEY, filter);
        } catch { /* ignore */ }
    }

    const getTask = (li) => tasks.find((t) => t.id === li.dataset.id);

    /* ---------- View ---------- */

    /** Updates everything on screen that depends on `tasks` and `filter`. */
    function refresh() {
        const total = tasks.length;
        const done = tasks.filter((t) => t.done).length;
        const active = total - done;
        const percent = total === 0 ? 0 : Math.round((done / total) * 100);

        // Progress bar
        dom.pFill.style.width = `${percent}%`;
        dom.pPercent.textContent = `${percent}%`;
        dom.pTrack.setAttribute('aria-valuenow', percent);
        dom.pWrap.classList.toggle('complete', total > 0 && done === total);
        dom.pLabel.textContent =
            total === 0 ? 'No tasks yet'
            : done === total ? 'All tasks done!'
            : `${done} of ${total} tasks done`;

        // Filtering
        let visible = 0;
        for (const task of tasks) {
            const li = rows.get(task.id);
            if (!li) continue;
            const show = filter === 'all' || (filter === 'active' ? !task.done : task.done);
            li.hidden = !show;
            if (show) visible++;
        }

        // Filter tabs, counts, footer, empty state
        const counts = { all: total, active, done };
        for (const btn of dom.filterBtns) {
            const name = btn.dataset.filter;
            btn.setAttribute('aria-pressed', String(name === filter));
            btn.querySelector('.count').textContent = counts[name];
        }
        dom.left.textContent = `${active} ${active === 1 ? 'task' : 'tasks'} left`;
        dom.clear.disabled = done === 0;
        dom.empty.hidden = visible > 0;
        dom.emptyText.textContent = EMPTY_TEXT[filter];
    }

    /** Save, then redraw the parts of the page that depend on the data. */
    function commit() {
        saveTasks();
        refresh();
    }

    function createRow(task) {
        const li = dom.template.content.firstElementChild.cloneNode(true);
        li.dataset.id = task.id;
        li.classList.toggle('completed', task.done);
        li.querySelector('.task-check').checked = task.done;
        li.querySelector('.task-text').textContent = task.text;
        rows.set(task.id, li);
        return li;
    }

    function rebuild() {
        rows.clear();
        dom.list.replaceChildren(...tasks.map(createRow));
        refresh();
    }

    /* ---------- Actions ---------- */

    function addTask(text) {
        const task = { id: makeId(), text, done: false };
        tasks.push(task);
        dom.list.append(createRow(task));
        commit();
    }

    function toggleTask(li, done) {
        const task = getTask(li);
        if (!task) return;
        task.done = done;
        li.classList.toggle('completed', done);
        commit();
    }

    /** Remove tasks by id. They are gone from storage immediately; Undo can bring them back. */
    function removeTasks(ids) {
        const items = [];
        tasks = tasks.filter((task, index) => {
            if (!ids.has(task.id)) return true;
            items.push({ task, index });
            return false;
        });
        if (!items.length) return;

        for (const { task } of items) {
            const li = rows.get(task.id);
            rows.delete(task.id);
            if (!li) continue;
            li.classList.add('removing');
            li.querySelectorAll('button, input').forEach((el) => (el.disabled = true));
            setTimeout(() => li.remove(), reduceMotion.matches ? 0 : REMOVE_MS);
        }

        commit();
        showToast(items);
    }

    function restoreTasks(items) {
        // Re-insert lowest index first so every task lands back in its old position
        for (const { task, index } of [...items].sort((a, b) => a.index - b.index)) {
            tasks.splice(index, 0, task);
            const next = tasks[index + 1];
            dom.list.insertBefore(createRow(task), (next && rows.get(next.id)) || null);
        }
        commit();
    }

    /* ---------- Editing ---------- */

    function startEdit(li) {
        const task = getTask(li);
        const editBtn = li.querySelector('.edit-btn');

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'edit-input';
        input.value = task.text;
        input.maxLength = MAX_LEN;
        input.setAttribute('aria-label', 'Task text');

        li.querySelector('.task-text').replaceWith(input);
        input.focus();
        input.select();

        editBtn.classList.add('saving');
        editBtn.setAttribute('aria-label', 'Save task');
    }

    function finishEdit(li, save = true) {
        const input = li.querySelector('.edit-input');
        if (!input) return;

        const task = getTask(li);
        const editBtn = li.querySelector('.edit-btn');
        const next = input.value.trim();

        if (save && next && next !== task.text) {
            task.text = next;
            commit();
        }

        const text = document.createElement('span');
        text.className = 'task-text';
        text.textContent = task.text;
        input.replaceWith(text);

        editBtn.classList.remove('saving');
        editBtn.setAttribute('aria-label', 'Edit task');
        editBtn.focus();
    }

    /* ---------- Undo message ---------- */

    function showToast(items) {
        pendingUndo = { items };
        dom.toastText.textContent = items.length === 1 ? 'Task deleted' : `${items.length} tasks removed`;
        dom.toast.hidden = false;
        // restart the entrance animation for back-to-back deletes
        dom.toast.style.animation = 'none';
        void dom.toast.offsetWidth;
        dom.toast.style.animation = '';

        clearTimeout(undoTimer);
        undoTimer = setTimeout(hideToast, UNDO_MS);
    }

    function hideToast() {
        clearTimeout(undoTimer);
        dom.toast.hidden = true;
        pendingUndo = null;
    }

    /* ---------- Events ---------- */

    dom.form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = dom.input.value.trim();
        if (!text) return;
        addTask(text.slice(0, MAX_LEN));
        dom.input.value = '';
        dom.input.focus();
    });

    dom.list.addEventListener('change', (e) => {
        if (e.target.matches('.task-check')) {
            toggleTask(e.target.closest('.task-item'), e.target.checked);
        }
    });

    dom.list.addEventListener('click', (e) => {
        const li = e.target.closest('.task-item');
        if (!li || li.classList.contains('removing')) return;

        if (e.target.closest('.delete-btn')) {
            removeTasks(new Set([li.dataset.id]));
        } else if (e.target.closest('.edit-btn')) {
            li.querySelector('.edit-input') ? finishEdit(li) : startEdit(li);
        }
    });

    // Double-click a task's text to edit it
    dom.list.addEventListener('dblclick', (e) => {
        const text = e.target.closest('.task-text');
        if (text) startEdit(text.closest('.task-item'));
    });

    dom.list.addEventListener('keydown', (e) => {
        if (!e.target.matches('.edit-input')) return;
        const li = e.target.closest('.task-item');
        if (e.key === 'Enter') {
            e.preventDefault();
            finishEdit(li);
        } else if (e.key === 'Escape') {
            finishEdit(li, false);
        }
    });

    dom.filterBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.filter-btn');
        if (!btn) return;
        filter = btn.dataset.filter;
        saveFilter();
        refresh();
    });

    dom.clear.addEventListener('click', () => {
        removeTasks(new Set(tasks.filter((t) => t.done).map((t) => t.id)));
    });

    dom.undo.addEventListener('click', () => {
        if (!pendingUndo) return;
        restoreTasks(pendingUndo.items);
        hideToast();
    });

    // Press "/" anywhere to jump to the input
    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target.closest('input, textarea, [contenteditable]')) return;
        e.preventDefault();
        dom.input.focus();
    });

    // Keep several open tabs in sync
    window.addEventListener('storage', (e) => {
        if (e.key !== STORAGE_KEY) return;
        tasks = loadTasks();
        rebuild();
    });

    // If the empty-state image is missing, drop it instead of showing a broken icon
    dom.empty.querySelector('img')?.addEventListener('error', (e) => e.target.remove());

    /* ---------- Start ---------- */

    if (dom.date) {
        dom.date.textContent = new Intl.DateTimeFormat(undefined, {
            weekday: 'long', day: 'numeric', month: 'long',
        }).format(new Date());
    }

    rebuild();
    saveTasks(); // also writes back any tasks migrated from the older saved format
})();