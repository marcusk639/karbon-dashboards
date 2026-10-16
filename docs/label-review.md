# Label review

the owner runs these three statements in **Snowsight** (never through Claude), decides an outcome for each value, and records it in `config/labels.json` with date and reviewer. A value that names or implies a client gets `alias` or `other`, never `approve`.

```sql
SELECT DISTINCT PRIMARY_STATUS FROM WORK_ITEM_DETAILS WHERE COMPLETED_DATETIME IS NULL AND PRIMARY_STATUS <> 'Planned';
SELECT DISTINCT COALESCE(NULLIF(SECONDARY_STATUS,''), '(no stage recorded)') FROM WORK_ITEM_DETAILS WHERE COMPLETED_DATETIME IS NULL AND PRIMARY_STATUS <> 'Planned';
SELECT DISTINCT WORK_TYPE FROM WORK_ITEM_DETAILS WHERE COMPLETED_DATETIME IS NULL AND PRIMARY_STATUS <> 'Planned';
```
