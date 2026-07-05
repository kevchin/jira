# JIRA Relationship Visualizer — Deployment Guide

**Purpose:** Deploy to GitHub and re-deploy on another system  
**Date:** 2026-07-04  

---

## 1. Repository Setup

### 1.1 Create GitHub Repository

1. Go to GitHub and create a new repository:
   ```bash
   gh repo create jira-relationship-visualizer --private
   ```

2. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/jira-relationship-visualizer.git
   cd jira-relationship-visualizer
   ```

3. Copy project files:
   ```bash
   cp -r /path/to/your/jira/* .
   ```

### 1.2 Git Ignore

Create `.gitignore` to exclude sensitive and generated files:

```gitignore
# Credentials
JIRA_API.key

# Logs
jira_viz.log

# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
env/
venv/
ENV/
build/
develop-eggs/
dist/
downloads/
eggs/
.eggs/
lib/
lib64/
parts/
sdist/
var/
wheels/
*.egg-info/
.installed.cfg
*.egg

# IDE
.vscode/
.idea/
*.swp
*.swo
*~

# OS
.DS_Store
Thumbs.db

# Graph data (optional - uncomment if needed)
# phase1_graph.json
```

### 1.3 Initial Commit

```bash
git add .
git commit -m "Initial commit: JIRA Relationship Visualizer v1.0"
git push origin main
```

---

## 2. Deployment to Another System

### 2.1 Prerequisites

- Python 3.10+
- pip
- Browser (Chrome, Firefox, Edge)
- JIRA account with API access

### 2.2 Clone and Install

```bash
# Clone repository
git clone https://github.com/yourusername/jira-relationship-visualizer.git
cd jira-relationship-visualizer

# Create virtual environment (recommended)
python -m venv venv
source venv/bin/activate  # Linux/Mac
# venv\Scripts\activate   # Windows

# Install dependencies
pip install -r requirements.txt
```

### 2.3 Configuration

1. **Create API key file:**
   ```bash
   # Create JIRA_API.key with your credentials
   echo "your-email@example.com:your-api-token" > JIRA_API.key
   ```

   **How to get JIRA API token:**
   - Go to https://id.atlassian.com/manage-profile/security/api-tokens
   - Click "Create API token"
   - Name it (e.g., "jira-visualizer")
   - Copy the token (you won't see it again)
   - Format: `email:token`

2. **Update JIRA URL (if self-hosted):**
   Edit `jira_viz/server.py` and update:
   ```python
   JIRA_BASE_URL = "https://your-instance.atlassian.net/"
   # or for self-hosted:
   # JIRA_BASE_URL = "https://jira.yourcompany.com/"
   ```

3. **Verify configuration:**
   ```bash
   python -c "from jira_viz.fetcher import JIRAFetcher; f = JIRAFetcher(); print('Connected:', f.jira)"
   ```

### 2.4 Run the Application

```bash
# Option 1: Using run script
./run_server.sh

# Option 2: Direct uvicorn
python -m uvicorn jira_viz.server:app --reload --port 8000

# Option 3: Production mode (no auto-reload)
python -m uvicorn jira_viz.server:app --host 0.0.0.0 --port 8000
```

### 2.5 Access the Application

Open browser to:
```
http://localhost:8000
```

For remote access, bind to `0.0.0.0`:
```bash
python -m uvicorn jira_viz.server:app --host 0.0.0.0 --port 8000
```

Then access via:
```
http://server-ip:8000
```

**Note:** For production, use a reverse proxy (nginx) and HTTPS.

---

## 3. Production Deployment

### 3.1 Systemd Service (Linux)

Create `/etc/systemd/system/jira-viz.service`:

```ini
[Unit]
Description=JIRA Relationship Visualizer
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/jira-relationship-visualizer
Environment="PATH=/path/to/jira-relationship-visualizer/venv/bin"
ExecStart=/path/to/jira-relationship-visualizer/venv/bin/uvicorn jira_viz.server:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable jira-viz
sudo systemctl start jira-viz
sudo systemctl status jira-viz
```

### 3.2 Nginx Reverse Proxy

Create `/etc/nginx/sites-available/jira-viz`:

```nginx
server {
    listen 80;
    server_name jira-viz.yourcompany.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable and reload:
```bash
sudo ln -s /etc/nginx/sites-available/jira-viz /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 3.3 HTTPS with Let's Encrypt

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d jira-viz.yourcompany.com
```

---

## 4. Updating the Application

### 4.1 Pull Latest Changes

```bash
cd /path/to/jira-relationship-visualizer
git pull origin main
```

### 4.2 Update Dependencies

```bash
pip install -r requirements.txt --upgrade
```

### 4.3 Restart Service

```bash
# If using systemd
sudo systemctl restart jira-viz

# If running manually
# Press Ctrl+C to stop, then restart
```

---

## 5. Troubleshooting

### 5.1 Port Already in Use

```bash
# Check what's using the port
lsof -i :8000

# Kill the process
kill <PID>

# Or use a different port
python -m uvicorn jira_viz.server:app --port 8001
```

### 5.2 Authentication Failed

```bash
# Check JIRA_API.key format
cat JIRA_API.key
# Should be: email:token (no spaces, no quotes)

# Test connection
python -c "from jira_viz.fetcher import JIRAFetcher; f = JIRAFetcher(); print(f.fetch_issues('project = OKR', max_results=1))"
```

### 5.3 Module Not Found

```bash
# Reinstall dependencies
pip install -r requirements.txt --force-reinstall

# Check Python version
python --version  # Should be 3.10+
```

### 5.4 Log File Issues

```bash
# Check log file permissions
ls -la jira_viz.log

# Clear log file (optional)
> jira_viz.log

# Check log contents
tail -50 jira_viz.log
```

---

## 6. Backup and Recovery

### 6.1 What to Backup

- `JIRA_API.key` (credentials)
- `jira_viz.log` (session logs, optional)
- Custom configurations in `server.py` (if modified)

### 6.2 Recovery Steps

1. Clone repository on new system
2. Install dependencies
3. Copy `JIRA_API.key` from backup
4. Start application

---

## 7. Security Considerations

### 7.1 API Key Storage

- Store `JIRA_API.key` in a secure location
- Use `.gitignore` to prevent committing
- Consider environment variables for production:
  ```python
  # In server.py
  import os
  JIRA_API_KEY = os.getenv("JIRA_API_KEY")
  ```

### 7.2 Network Security

- Do not expose port 8000 to the internet without authentication
- Use HTTPS in production
- Consider VPN access for sensitive JIRA instances
- Implement rate limiting for multi-user deployments

### 7.3 JIRA Permissions

- API token should have minimal required permissions
- Recommended: "Browse Projects" and "Create Issue Links"
- Review JIRA project permissions regularly

---

## 8. Monitoring

### 8.1 Log Monitoring

```bash
# Tail log in real-time
tail -f jira_viz.log

# Search for errors
grep ERROR jira_viz.log

# Count operations by type
grep -c "Added relationship" jira_viz.log
grep -c "Deleted relationship" jira_viz.log
```

### 8.2 Service Monitoring

```bash
# Check systemd service status
sudo systemctl status jira-viz

# Check if port is listening
netstat -tlnp | grep 8000

# Check process
ps aux | grep uvicorn
```

---

## 9. Performance Tuning

### 9.1 Node Count Limits

- **Recommended:** ≤50 nodes for optimal performance
- **Maximum:** ~100 nodes (may be slow)
- **Adjust limit:** Edit `MAX_ISSUES_TO_DISPLAY` in `static/app.js`

### 9.2 Layout Algorithm

- Force-directed layout works best for ≤50 nodes
- For larger graphs, consider:
  - Pre-computing positions in Python
  - Using hierarchical layout
  - Limiting JQL query results

### 9.3 Memory Usage

- Typical: 100-200 MB for 50 nodes
- Monitor with: `top` or `htop`
- Restart service if memory grows excessively

---

## 10. Changelog

### v1.0 (2026-07-04)

- Initial production release
- All phases 0-6 implemented and tested
- 34 passing tests
- Dark and light themes
- Search and filter with strict mode
- Commit workflow with dry-run
- Live logging with pasteable format
- Keyboard shortcuts
- Graceful shutdown

---

## 11. Support and Feedback

For issues or feature requests:

1. Check `jira_viz.log` for error details
2. Paste log contents into chat for debugging
3. Include:
   - JIRA version (Cloud vs Server)
   - Number of issues in query
   - Steps to reproduce
   - Expected vs actual behavior

---

**End of Deployment Guide**
