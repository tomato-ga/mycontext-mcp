import "dotenv/config";
import { runDoctor } from "./commands/doctor.js";
import { runDoctorBusinessKnowledge } from "./commands/doctorBusinessKnowledge.js";
import { runDoctorAuthorStyle } from "./commands/doctorAuthorStyle.js";
import { runDoctorEditorKnowledge } from "./commands/doctorEditorKnowledge.js";
import { runDoctorMetaskill } from "./commands/doctorMetaskill.js";
import { runExportObsidian } from "./commands/exportObsidian.js";
import { runExportAuthorStyleMarkdown } from "./commands/exportAuthorStyleMarkdown.js";
import { runRestoreAuthorStyleMarkdown } from "./commands/restoreAuthorStyleMarkdown.js";
import { runPreflightAuthorStyleNotion } from "./commands/preflightAuthorStyleNotion.js";
import { runMigrate } from "./commands/migrate.js";
import { runMigrateBusinessKnowledge } from "./commands/migrateBusinessKnowledge.js";
import { runMigrateEditorKnowledge } from "./commands/migrateEditorKnowledge.js";
import { runMigrateAuthorStyle } from "./commands/migrateAuthorStyle.js";
import { runMigrateMetaskill } from "./commands/migrateMetaskill.js";
import { runMigrateSyncStateLog } from "./commands/migrateSyncStateLog.js";
import { runPull } from "./commands/pull.js";
import { runPullBusinessKnowledge } from "./commands/pullBusinessKnowledge.js";
import { runPullEditorKnowledge } from "./commands/pullEditorKnowledge.js";
import { runPullMetaskill } from "./commands/pullMetaskill.js";
import { runSearch } from "./commands/search.js";
import { runAuditSyncState } from "./commands/auditSyncState.js";
import { AppError, errorMessage, type CliFlags } from "./types.js";

try {
  const command = process.argv[2];
  const flags = parseFlags(process.argv.slice(3));
  switch (command) {
    case "migrate":
      await runMigrate(flags);
      break;
    case "pull":
      await runPull(flags);
      break;
    case "pull-editor-knowledge":
      await runPullEditorKnowledge(flags);
      break;
    case "migrate-business-knowledge":
      await runMigrateBusinessKnowledge(flags);
      break;
    case "migrate-editor-knowledge":
      await runMigrateEditorKnowledge(flags);
      break;
    case "migrate-author-style":
      await runMigrateAuthorStyle(flags);
      break;
    case "migrate-metaskill":
      await runMigrateMetaskill(flags);
      break;
    case "migrate-sync-state-log":
      await runMigrateSyncStateLog(flags);
      break;
    case "pull-business-knowledge":
      await runPullBusinessKnowledge(flags);
      break;
    case "pull-metaskill":
      await runPullMetaskill(flags);
      break;
    case "doctor":
      await runDoctor(flags);
      break;
    case "doctor-editor-knowledge":
      await runDoctorEditorKnowledge(flags);
      break;
    case "doctor-business-knowledge":
      await runDoctorBusinessKnowledge(flags);
      break;
    case "doctor-author-style":
      await runDoctorAuthorStyle(flags);
      break;
    case "doctor-metaskill":
      await runDoctorMetaskill(flags);
      break;
    case "export-obsidian":
      await runExportObsidian(flags);
      break;
    case "export-author-style-markdown":
      await runExportAuthorStyleMarkdown(flags);
      break;
    case "restore-author-style-markdown":
      await runRestoreAuthorStyleMarkdown(flags);
      break;
    case "preflight-author-style-notion":
      await runPreflightAuthorStyleNotion(flags);
      break;
    case "search":
      await runSearch(flags);
      break;
    case "audit-sync-state":
      await runAuditSyncState(flags);
      break;
    default:
      throw new AppError("unknown_command", `unknown command: ${command ?? "(missing)"}`, 3);
  }
} catch (error) {
  if (error instanceof AppError) {
    console.error(`${error.code}: ${error.message}`);
    process.exit(error.exitCode);
  }
  console.error(`unexpected_error: ${errorMessage(error)}`);
  process.exit(1);
}

export function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = {
    config: "mirror.config.json",
    dryRun: false,
    reindex: false,
    activateEmergency: false,
    topK: 5
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--":
        continue;
      case "--config":
        flags.config = requireValue(args, ++index, "--config");
        break;
      case "--page-id":
        flags.pageId = requireValue(args, ++index, "--page-id");
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--reindex":
        flags.reindex = true;
        break;
      case "--query":
        flags.query = requireValue(args, ++index, "--query");
        break;
      case "--top-k": {
        const topK = Number(requireValue(args, ++index, "--top-k"));
        if (!Number.isInteger(topK) || topK <= 0) {
          throw new AppError("invalid_flag", "--top-k must be a positive integer", 3);
        }
        flags.topK = topK;
        break;
      }
      case "--vault-path":
        flags.vaultPath = requireValue(args, ++index, "--vault-path");
        break;
      case "--output-dir":
        flags.outputDir = requireValue(args, ++index, "--output-dir");
        break;
      case "--document-id":
        flags.documentId = requireValue(args, ++index, "--document-id");
        break;
      case "--input-path":
        flags.inputPath = requireValue(args, ++index, "--input-path");
        break;
      case "--output-path":
        flags.outputPath = requireValue(args, ++index, "--output-path");
        break;
      case "--activate-emergency":
        flags.activateEmergency = true;
        break;
      default:
        throw new AppError("unknown_flag", `unknown flag: ${arg ?? "(missing)"}`, 3);
    }
  }

  return flags;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new AppError("missing_flag_value", `${flag} requires a value`, 3);
  }
  return value;
}
