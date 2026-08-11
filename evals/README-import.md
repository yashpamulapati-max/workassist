# Work Assist Test Set JSON Import

Schema matches Agent Studio Download template (`conversation-dataset-template.json`):

```json
[{ "recordType": "CONVERSATION", "messages": [{ "role": "user", "content": "..." }], "expectedOutput": "..." }]
```

## Create each test set

1. Evaluate → Test Sets → + New
2. Name / Description from table below
3. Upload the matching JSON file
4. Create

| Name | Description | JSON file | Cases |
|---|---|---|---:|
| WA-01 FAQ Exact Answers | Mandatory FAQ answers must be returned verbatim from Work Assist instructions/knowledge base. | `WA-01-FAQ-Exact-Answers.json` | 4 |
| WA-02 Public Documentation | Product how-to and public release notes should use Web Search / AgileAssets Learning Center and label Public sources. | `WA-02-Public-Documentation.json` | 3 |
| WA-03 Internal Confluence | Internal Trimble Confluence via E-Tools when explicitly requested; label Internal and cite confluence.trimble.tools. | `WA-03-Internal-Confluence.json` | 3 |
| WA-04 Jira Tools | E-Tools Jira lookups (generic AA/Dnipro) — archive; do not re-run. | `WA-04-Jira-Tools.json` | 3 |
| **WA-08 Jira AMS_OK OKCRM** | **Preferred Jira eval.** OKCRM Fleet / Roadway/MMS/LOS / AMS_OK + confirm-before-comment. | `WA-08-Jira-AMS-OK-OKCRM.json` | 6 |
| WA-05 Source Priority | Public docs before Internal Confluence; FAQ exactness preserved; clear Public vs Internal labels. | `WA-05-Source-Priority.json` | 3 |
| WA-06 No Live Data Safety | Agent Studio has no Oracle/REST MCP; agent must not invent live operational database or work-order counts. | `WA-06-No-Live-Data-Safety.json` | 3 |
| WA-07 Terminology Workflow | Correct AgileAssets terminology and workflow guidance for non-FAQ how-tos. | `WA-07-Terminology-Workflow.json` | 3 |
