from jira import JIRA
from jira_viz.config import JIRA_BASE_URL

# Configure your connection details
JIRA_SERVER = JIRA_BASE_URL
JIRA_EMAIL = "your-email@example.com"

# Read API key from file
with open("JIRA_API.key") as f:
    API_TOKEN = f.read().strip()

# Initialize the client
jira = JIRA(
    server=JIRA_SERVER,
    basic_auth=(JIRA_EMAIL, API_TOKEN)
)

# Retrieve a single issue by its key
issue = jira.issue("OKR-8")

# Print core fields
print(f"Summary: {issue.fields.summary}")
print(f"Status: {issue.fields.status.name}")
print(f"Assignee: {issue.fields.assignee}")

# Search for open bugs assigned to the current user
jql_query = "project = OKR AND issuetype = Bug AND status = 'To Do'"
issues = jira.search_issues(jql_query, maxResults=10)

for issue in issues:
    print(f"{issue.key}: {issue.fields.summary}")
