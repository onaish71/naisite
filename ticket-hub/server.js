const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const ALERTS_FILE = path.join(__dirname, 'alerts.json');
const TENANTS_FILE = path.join(__dirname, 'tenants.json');

const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const VALID_STATUSES = ['open', 'in-progress', 'resolved', 'closed'];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadAlerts() {
    if (!fs.existsSync(ALERTS_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); }
    catch { return []; }
}
function saveAlerts(alerts) { fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2)); }
function loadTenants() {
    try { return JSON.parse(fs.readFileSync(TENANTS_FILE, 'utf8')); }
    catch { return []; }
}

function authTenant(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'X-Api-Key header required' });
    const tenant = loadTenants().find(t => t.apiKey === apiKey);
    if (!tenant) return res.status(403).json({ error: 'Invalid API key' });
    req.tenant = tenant;
    next();
}

app.post('/api/alerts', authTenant, (req, res) => {
    const { summary, severity, description, source, metadata } = req.body;
    if (!summary) return res.status(400).json({ error: 'summary is required' });
    if (severity && !VALID_SEVERITIES.includes(severity))
        return res.status(400).json({ error: `severity must be one of: ${VALID_SEVERITIES.join(', ')}` });
    const alert = {
        id: uuidv4(), tenantId: req.tenant.id, tenantName: req.tenant.name,
        summary, severity: severity || 'medium', description: description || '',
        source: source || '', metadata: metadata || {}, status: 'open',
        receivedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        assignedTo: null, notes: ''
    };
    const alerts = loadAlerts();
    alerts.unshift(alert);
    saveAlerts(alerts);
    res.status(201).json(alert);
});

app.get('/api/alerts', (req, res) => {
    let alerts = loadAlerts();
    const { status, severity, tenantId, limit = 200 } = req.query;
    if (status) alerts = alerts.filter(a => a.status === status);
    if (severity) alerts = alerts.filter(a => a.severity === severity);
    if (tenantId) alerts = alerts.filter(a => a.tenantId === tenantId);
    res.json(alerts.slice(0, parseInt(limit)));
});

app.get('/api/alerts/:id', (req, res) => {
    const alert = loadAlerts().find(a => a.id === req.params.id);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json(alert);
});

app.patch('/api/alerts/:id', (req, res) => {
    const alerts = loadAlerts();
    const idx = alerts.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Alert not found' });
    const { status, assignedTo, notes } = req.body;
    if (status) {
        if (!VALID_STATUSES.includes(status))
            return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
        alerts[idx].status = status;
    }
    if (assignedTo !== undefined) alerts[idx].assignedTo = assignedTo;
    if (notes !== undefined) alerts[idx].notes = notes;
    alerts[idx].updatedAt = new Date().toISOString();
    saveAlerts(alerts);
    res.json(alerts[idx]);
});

app.get('/api/tenants', (req, res) => {
    res.json(loadTenants().map(({ id, name }) => ({ id, name })));
});

app.get('/api/stats', (req, res) => {
    const alerts = loadAlerts();
    res.json({
        total: alerts.length,
        open: alerts.filter(a => a.status === 'open').length,
        inProgress: alerts.filter(a => a.status === 'in-progress').length,
        resolved: alerts.filter(a => ['resolved', 'closed'].includes(a.status)).length,
        critical: alerts.filter(a => a.severity === 'critical').length,
        high: alerts.filter(a => a.severity === 'high').length,
        medium: alerts.filter(a => a.severity === 'medium').length,
        low: alerts.filter(a => a.severity === 'low').length,
    });
});

app.listen(PORT, () => console.log(`Ticket Hub → http://localhost:${PORT}`));
