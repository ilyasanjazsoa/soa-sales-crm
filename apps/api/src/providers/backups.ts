import { DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";

/* The database backup check for maintenance.nightly (§14): when the latest point-in-time restore point was made. */
export interface BackupChecker {
  /** The latest restorable time, or null when it can't be determined. */
  latestRestorableTime: () => Promise<Date | null>;
}

export function createRdsBackupChecker(options: { region: string; instanceId: string }): BackupChecker {
  const client = new RDSClient({ region: options.region });
  return {
    async latestRestorableTime() {
      const result = await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: options.instanceId }));
      return result.DBInstances?.[0]?.LatestRestorableTime ?? null;
    },
  };
}

/** Local and CI: there is no managed backup; reports "just now" so nothing alarms. */
export const fakeBackupChecker: BackupChecker = { latestRestorableTime: () => Promise.resolve(new Date()) };
