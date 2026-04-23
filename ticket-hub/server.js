const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const app = express();
const PORT = process.env.PORT || 3000;
const TENANTS_FILE = path.join(__dirname, 'tenants.json');
const TABLE = process.env.ALERTS_TABLE || 'ticket-hub-alerts';

const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' })
);

const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const VALID_STATUSES = ['open', 'in-progress', 'resolved', 'closed'];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

app.post('/api/alerts', authTenant, async (req, res) => {
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
    await ddb.send(new PutCommand({ TableName: TABLE, Item: alert }));
    res.status(201).json(alert);
});

app.get('/api/alerts', async (req, res) => {
    const { status, severity, tenantId, limit = 200 } = req.query;
    const result = await ddb.send(new ScanCommand({ TableName: TABLE }));
    let alerts = (result.Items || []).sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    if (status) alerts = alerts.filter(a => a.status === status);
    if (severity) alerts = alerts.filter(a => a.severity === severity);
    if (tenantId) alerts = alerts.filter(a => a.tenantId === tenantId);
    res.json(alerts.slice(0, parseInt(limit)));
});

app.get('/api/alerts/:id', async (req, res) => {
    const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id: req.params.id } }));
    if (!result.Item) return res.status(404).json({ error: 'Alert not found' });
    res.json(result.Item);
});

app.patch('/api/alerts/:id', async (req, res) => {
    const { status, assignedTo, notes } = req.body;
    if (status && !VALID_STATUSES.includes(status))
        return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });

    const check = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id: req.params.id } }));
    if (!check.Item) return res.status(404).json({ error: 'Alert not found' });

    const updates = { updatedAt: new Date().toISOString() };
    if (status) updates.status = status;
    if (assignedTo !== undefined) updates.assignedTo = assignedTo;
    if (notes !== undefined) updates.notes = notes;

    const expr = Object.keys(updates).map((k, i) => `#f${i} = :v${i}`).join(', ');
    const names = Object.fromEntries(Object.keys(updates).map((k, i) => [`#f${i}`, k]));
    const values = Object.fromEntries(Object.keys(updates).map((k, i) => [`:v${i}`, updates[k]]));

    const result = await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { id: req.params.id },
        UpdateExpression: `SET ${expr}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW'
    }));
    res.json(result.Attributes);
});

app.get('/api/tenants', (req, res) => {
    res.json(loadTenants().map(({ id, name }) => ({ id, name })));
});

app.get('/api/stats', async (req, res) => {
    const result = await ddb.send(new ScanCommand({ TableName: TABLE }));
    const alerts = result.Items || [];
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
