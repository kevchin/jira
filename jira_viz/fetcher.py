"""
JIRA API client for jira_viz Phase 0.

Wraps the `jira` library with:
- HTTP error logging (full context: method, URL, status, response, action)
- Graceful connection lifecycle
- Fetch issues by JQL
- Fetch available link types
"""

import logging
from pathlib import Path
from typing import List, Optional

from jira import JIRA, JIRAError
from jira_viz.config import JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_KEY_FILE, JIRA_START_DATE_FIELD
from jira_viz.logger import log_http_error
from jira_viz.models import JiraIssue


def _extract_original_estimate(issue) -> Optional[int]:
    """Extract timeoriginalestimate (seconds) from a JIRA issue raw data."""
    try:
        if issue.raw and issue.raw.get("fields"):
            toe = issue.raw["fields"].get("timeoriginalestimate")
            if toe is not None:
                return int(toe)
    except (TypeError, ValueError, KeyError):
        pass
    return None


def _extract_start_date(issue) -> Optional[str]:
    """Extract start date from a JIRA issue using the configured custom field."""
    try:
        if issue.raw and issue.raw.get("fields"):
            val = issue.raw["fields"].get(JIRA_START_DATE_FIELD)
            if val:
                return str(val)
    except (TypeError, KeyError):
        pass
    return None


class JIRAFetcher:
    """
    Thin wrapper around jira.JIRA that logs HTTP errors with full context.

    Usage:
        fetcher = JIRAFetcher(logger)
        fetcher.connect()
        issues = fetcher.fetch_issues("project = OKR AND status != Done")
        link_types = fetcher.fetch_link_types()
        fetcher.close()
    """

    def __init__(
        self,
        logger: logging.Logger,
        server: str = JIRA_BASE_URL,
        email: str = JIRA_EMAIL,
        key_file: Optional[Path] = None,
    ):
        self.logger = logger
        self.server = server
        self.email = email
        self.key_file = key_file or JIRA_API_KEY_FILE
        self._jira: Optional[JIRA] = None

    def connect(self) -> None:
        """Connect to JIRA. Logs connection attempt and any errors."""
        self.logger.info("Connecting to JIRA at %s ...", self.server)

        if not self.key_file.exists():
            self.logger.error(
                "JIRA API key file not found: %s", self.key_file
            )
            raise FileNotFoundError(
                f"API key file not found: {self.key_file}. "
                f"Create it with your API token (one line)."
            )

        api_token = self.key_file.read_text().strip()

        try:
            self._jira = JIRA(
                server=self.server,
                basic_auth=(self.email, api_token),
            )
            self.logger.info("Connected to JIRA successfully.")
        except JIRAError as e:
            self._log_jira_error(e, action="connect()")
            raise
        except Exception as e:
            self.logger.error("Unexpected error connecting to JIRA: %s", e)
            raise

    def fetch_issues(self, jql: str, max_results: int = 50) -> List[JiraIssue]:
        """
        Fetch issues matching a JQL query.

        Args:
            jql: JIRA Query Language string
            max_results: Maximum number of results (default 50)

        Returns:
            List of JiraIssue objects
        """
        if self._jira is None:
            self.logger.error("JIRA client not connected. Call connect() first.")
            raise RuntimeError("JIRA client not connected")
        
        self.logger.info("Fetching issues with JQL: %s", jql)

        try:
            results = self._jira.search_issues(jql, maxResults=max_results)
        except JIRAError as e:
            self._log_jira_error(e, action=f"fetch_issues(jql='{jql[:80]}...')")
            raise
        except Exception as e:
            self.logger.error("Unexpected error fetching issues: %s", e)
            raise

        issues = []
        for issue in results:
            # Construct JIRA web URL using issue key
            jira_web_url = f"{JIRA_BASE_URL}browse/{issue.key}"

            # Extract project from issue raw data
            project_key = None
            project_name = None
            if issue.raw and issue.raw.get("fields"):
                project = issue.raw["fields"].get("project", {})
                project_key = project.get("key")
                project_name = project.get("name")

            jira_issue = JiraIssue(
                key=issue.key,
                summary=issue.fields.summary,
                issue_type=issue.fields.issuetype.name if issue.fields.issuetype else "Unknown",
                status=issue.fields.status.name if issue.fields.status else "Unknown",
                priority=issue.fields.priority.name if issue.fields.priority else None,
                assignee=issue.fields.assignee.displayName if issue.fields.assignee else None,
                self_url=str(issue.self),
                jira_web_url=jira_web_url,
                project=project_key or project_name,
                original_estimate=_extract_original_estimate(issue),
                start_date=_extract_start_date(issue),
            )
            issues.append(jira_issue)

        self.logger.info("Fetched %d issues.", len(issues))
        for iss in issues:
            self.logger.debug("  %s — %s [%s] %s", iss.key, iss.summary, iss.issue_type, iss.status)

        return issues

    def fetch_issue_links(self, issue_key: str) -> List[dict]:
        """
        Fetch all links for a given issue.

        Args:
            issue_key: Issue key (e.g. 'OKR-1')

        Returns:
            List of dicts with 'type', 'inward_issue', 'outward_issue' keys
        """
        self.logger.info("Fetching links for issue: %s", issue_key)

        try:
            # Use the JIRA REST API to get issue links
            import requests as req_lib
            # Get the issue with expanded fields to include links
            issue_url = f"{self.server}rest/api/2/issue/{issue_key}"
            response = req_lib.get(issue_url, auth=self._jira._session.auth,
                                   headers={"Accept": "application/json"})
            response.raise_for_status()
            issue_data = response.json()

            # Extract links from the issue fields
            fields = issue_data.get("fields", {})
            links = fields.get("issuelinks", [])

            result = []
            for link in links:
                link_type = link.get("type", {}).get("name", "Unknown")
                inward = link.get("inwardIssue", {})
                outward = link.get("outwardIssue", {})

                # When querying an issue's links, JIRA only returns the other issue.
                # If inwardIssue is present, it's the other issue (and the current issue is outward).
                # If outwardIssue is present, it's the other issue (and the current issue is inward).
                # If neither is present, skip.
                if inward and not outward:
                    # inwardIssue is the other issue, current issue is outward (source/blocks)
                    result.append({
                        "type": link_type,
                        "inward_issue": inward.get("key"),  # other issue is inward (target/blocked)
                        "outward_issue": issue_key,  # current issue is outward (source/blocker)
                    })
                elif outward and not inward:
                    # outwardIssue is the other issue, current issue is inward (target/blocked)
                    result.append({
                        "type": link_type,
                        "inward_issue": issue_key,  # current issue is inward (target/blocked)
                        "outward_issue": outward.get("key"),  # other issue is outward (source/blocker)
                    })
                elif inward and outward:
                    # Both are present (full link)
                    result.append({
                        "type": link_type,
                        "inward_issue": inward.get("key"),
                        "outward_issue": outward.get("key"),
                    })
                else:
                    # Neither present, skip
                    continue

        except Exception as e:
            self.logger.error("Unexpected error fetching links for %s: %s", issue_key, e)
            return []

        self.logger.info("Found %d links for %s.", len(result), issue_key)
        for link in result:
            self.logger.debug("  %s [%s]", link["type"], link)

        return result

    def fetch_link_types(self) -> List[dict]:
        """
        Fetch available issue link types from JIRA.

        Returns:
            List of dicts with 'name', 'inward', 'outward' keys
        """
        self.logger.info("Fetching available link types ...")

        try:
            link_types = self._jira.issue_link_types()
        except JIRAError as e:
            self._log_jira_error(e, action="fetch_link_types()")
            raise
        except Exception as e:
            self.logger.error("Unexpected error fetching link types: %s", e)
            raise

        result = []
        for lt in link_types:
            result.append({
                "name": lt.name,
                "inward": lt.inward,
                "outward": lt.outward,
            })

        self.logger.info("Found %d link types: %s", len(result), [lt["name"] for lt in result])
        return result

    def create_issue_link(self, source_key: str, target_key: str, link_type: str) -> dict:
        """
        Create an issue link between two issues.

        Args:
            source_key: Source issue key
            target_key: Target issue key
            link_type: Link type name (e.g. 'Blocks')

        Returns:
            Dict with 'success', 'status', 'response' keys
        """
        self.logger.info("Creating link: %s -> %s (%s)", source_key, target_key, link_type)

        try:
            import requests as req_lib
            url = f"{self.server}rest/api/2/issueLink"
            headers = {"Content-Type": "application/json", "Accept": "application/json"}
            payload = {
                "type": {"name": link_type},
                "inwardIssue": {"key": target_key},
                "outwardIssue": {"key": source_key},
            }
            response = req_lib.post(url, json=payload, headers=headers,
                                    auth=self._jira._session.auth)
            response.raise_for_status()
            self.logger.info("Link created successfully: %s -> %s (%s)", source_key, target_key, link_type)
            return {"success": True, "status": response.status_code, "response": response.text[:200]}
        except Exception as e:
            self.logger.error("Failed to create link: %s -> %s (%s) - %s", source_key, target_key, link_type, e)
            return {"success": False, "status": getattr(e, 'status_code', None), "response": str(e)}

    def delete_issue_link(self, source_key: str, target_key: str, link_type: str) -> dict:
        """
        Delete an issue link between two issues.

        Args:
            source_key: Source issue key (outward)
            target_key: Target issue key (inward)
            link_type: Link type name (e.g. 'Blocks')

        Returns:
            Dict with 'success', 'status', 'response' keys
        """
        self.logger.info("Deleting link: %s -> %s (%s)", source_key, target_key, link_type)

        try:
            import requests as req_lib
            
            # Get all issue links using the correct endpoint
            url = f"{self.server}rest/api/2/issueLink"
            headers = {"Accept": "application/json", "Content-Type": "application/json"}
            auth = (self.email, self.key_file.read_text().strip()) if self.key_file else None
            
            response = req_lib.get(url, headers=headers, auth=auth)
            if response.status_code == 405:
                # Try alternative: get links from the source issue
                self.logger.info("issueLink endpoint not available, trying issue-based search")
                return self._delete_link_via_issue(source_key, target_key, link_type)
            
            response.raise_for_status()
            all_links = response.json()

            # Find the link matching our criteria
            link_id = None
            for link in all_links:
                outward = link.get('outwardIssue', {}).get('key')
                inward = link.get('inwardIssue', {}).get('key')
                lt = link.get('type', {}).get('name', '')
                if outward == source_key and inward == target_key and lt.lower() == link_type.lower():
                    link_id = link.get('id')
                    break

            if not link_id:
                self.logger.info("Link not found in JIRA (may be local-only): %s -> %s (%s)", source_key, target_key, link_type)
                # Treat as success - relationship doesn't exist in JIRA, so nothing to delete
                return {"success": True, "status": 200, "response": "Link not found in JIRA (local-only relationship)"}

            # Delete the link
            delete_url = f"{self.server}rest/api/2/issueLink/{link_id}"
            delete_response = req_lib.delete(delete_url, headers=headers, auth=auth)
            delete_response.raise_for_status()
            self.logger.info("Link deleted successfully: %s -> %s (%s)", source_key, target_key, link_type)
            return {"success": True, "status": delete_response.status_code, "response": delete_response.text[:200]}

        except Exception as e:
            self.logger.error("Failed to delete link: %s -> %s (%s) - %s", source_key, target_key, link_type, e)
            return {"success": False, "status": getattr(e, 'status_code', None), "response": str(e)}
    
    def _delete_link_via_issue(self, source_key: str, target_key: str, link_type: str) -> dict:
        """Delete link by searching through target issue's issuelinks field.
        
        Note: JIRA's issuelinks field behavior is counter-intuitive:
        - When querying an issue, it returns links where that issue is involved
        - If the issue is the TARGET (inward), inwardIssue shows the SOURCE
        - If the issue is the SOURCE (outward), outwardIssue shows the TARGET
        - The other field (outward/inward) will be None
        """
        self.logger.info("Trying to delete link via issue: %s -> %s (%s)", source_key, target_key, link_type)
        
        try:
            import requests as req_lib
            
            # Get the TARGET issue with issuelinks field
            issue_url = f"{self.server}rest/api/2/issue/{target_key}?fields=issuelinks"
            headers = {"Accept": "application/json", "Content-Type": "application/json"}
            auth = (self.email, self.key_file.read_text().strip()) if self.key_file else None
            
            response = req_lib.get(issue_url, headers=headers, auth=auth)
            response.raise_for_status()
            issue_data = response.json()
            
            # Search through links
            issuelinks = issue_data.get('fields', {}).get('issuelinks', [])
            self.logger.debug("Found %d issuelinks for %s (target)", len(issuelinks), target_key)
            
            for link in issuelinks:
                outward_issue = link.get('outwardIssue', {}).get('key') if link.get('outwardIssue') else None
                inward_issue = link.get('inwardIssue', {}).get('key') if link.get('inwardIssue') else None
                lt = link.get('type', {}).get('name', '')
                link_id = link.get('id')
                
                self.logger.debug("Checking link: id=%s, outward=%s, inward=%s, type=%s",
                    link_id, outward_issue, inward_issue, lt)
                
                # Match by link type and check if either outward or inward matches source_key
                # (the other field will be None or the target)
                if lt.lower() == link_type.lower():
                    # If inward is set, it's the source (target is the issue we queried)
                    if inward_issue == source_key:
                        self.logger.info("MATCH (inward=source)! Found link ID %s (%s: %s -> %s), deleting...",
                            link_id, lt, source_key, target_key)
                        
                        # Delete the link
                        delete_url = f"{self.server}rest/api/2/issueLink/{link_id}"
                        delete_response = req_lib.delete(delete_url, headers=headers, auth=auth)
                        delete_response.raise_for_status()
                        self.logger.info("Link deleted via issue: %s -> %s (%s)", source_key, target_key, link_type)
                        return {"success": True, "status": delete_response.status_code, "response": "Deleted"}
                    # If outward is set, it's the target (source is the issue we queried)
                    elif outward_issue == source_key:
                        self.logger.info("MATCH (outward=source)! Found link ID %s (%s: %s -> %s), deleting...",
                            link_id, lt, source_key, target_key)
                        
                        # Delete the link
                        delete_url = f"{self.server}rest/api/2/issueLink/{link_id}"
                        delete_response = req_lib.delete(delete_url, headers=headers, auth=auth)
                        delete_response.raise_for_status()
                        self.logger.info("Link deleted via issue: %s -> %s (%s)", source_key, target_key, link_type)
                        return {"success": True, "status": delete_response.status_code, "response": "Deleted"}
            
            self.logger.warning("Link not found in issue: %s -> %s (%s)", source_key, target_key, link_type)
            return {"success": False, "status": 404, "response": "Link not found"}

        except Exception as e:
            self.logger.error("Failed to delete link via issue: %s -> %s (%s) - %s", source_key, target_key, link_type, e)
            return {"success": False, "status": getattr(e, 'status_code', None), "response": str(e)}

    def close(self) -> None:
        """Close the JIRA connection."""
        if self._jira is not None:
            try:
                self._jira.close()
                self.logger.info("JIRA connection closed.")
            except Exception as e:
                self.logger.warning("Error closing JIRA connection: %s", e)
            self._jira = None

    def update_issue_field(self, issue_key: str, field_name: str, value) -> dict:
        """
        Update a single field on a JIRA issue.

        Args:
            issue_key: e.g. 'OKR-10'
            field_name: 'start_date' (maps to configured custom field)
                        or 'original_estimate' (uses timetracking object)
            value: string for start_date, int (seconds) for original_estimate

        Returns: {'success': bool, 'status': int, 'response': str}
        """
        import requests as req_lib
        from jira_viz.gantt import format_seconds_to_effort

        self.logger.info("Updating field %s on %s to: %s", field_name, issue_key, value)

        try:
            url = f"{self.server}rest/api/2/issue/{issue_key}"
            headers = {"Content-Type": "application/json", "Accept": "application/json"}

            if field_name == "original_estimate":
                # JIRA stores estimates via the timetracking object, not timeoriginalestimate.
                # The value must be a human-readable string like "3d", not raw seconds.
                effort_str = format_seconds_to_effort(int(value)) if value else None
                if not effort_str or effort_str == "—":
                    effort_str = "0h"
                payload = {
                    "fields": {
                        "timetracking": {
                            "originalEstimate": effort_str
                        }
                    }
                }
            elif field_name == "start_date":
                payload = {"fields": {JIRA_START_DATE_FIELD: value if value else None}}
            else:
                return {'success': False, 'status': 400, 'response': f'Unknown field: {field_name}'}

            auth = (self.email, self.key_file.read_text().strip())
            response = req_lib.put(url, json=payload, headers=headers, auth=auth)

            if response.status_code == 204:
                self.logger.info("Field updated: %s.%s = %s", issue_key, field_name, value)
                return {"success": True, "status": response.status_code, "response": ""}
            else:
                self.logger.error(
                    "Failed to update field: %s.%s — HTTP %d: %s",
                    issue_key, field_name, response.status_code, response.text[:200]
                )
                return {"success": False, "status": response.status_code, "response": response.text[:200]}

        except Exception as e:
            self.logger.error("Exception updating field %s on %s: %s", field_name, issue_key, e)
            return {"success": False, "status": getattr(e, 'status_code', None), "response": str(e)}

    def _log_jira_error(self, error: JIRAError, action: str) -> None:
        """
        Log a JIRAError with full HTTP context in the pasteable format.
        """
        log_http_error(
            self.logger,
            method=error.method or "UNKNOWN",
            url=error.url or "UNKNOWN",
            status_code=error.status_code or 0,
            action=action,
            response_body=error.text,
            message=f"JIRA API error: {error}",
        )
