/**
 * Pi Matrix Integration — v2 Configuration Schema
 *
 * This module provides:
 * - TypeScript interfaces for v2 config schema
 * - Migration function from v1 to v2
 * - Adaptive config consumer that handles both v1 and v2
 * - Single responsibility: All v2 config schema logic lives here
 *
 * V1 loading stays in config-utils.ts (loadConfig, saveConfig, validateConfig,
 * DEFAULT_CONFIG).
 * This module provides the bridge between v1, v2, and the code that consumes config.
 */

import type { MatrixConfig } from "./types.js";
import { DEFAULT_CONFIG, getActiveConfigDir, getConfigDir, getProjectConfigPath, getProjectCredentialsPath, loadConfig, parseJsonc, resolveConfigPath, saveConfig, seedConfigFile, getActiveProfileName, loadProfile, getValidConfig } from "./config-utils.js";
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

// =============================================================================
// V2 CONFIG SCHEMA TYPES
// =============================================================================

/**
 * v2 Configuration Schema
 * Each feature has its own section with an `enabled` toggle.
 * Core infrastructure sections don't represent user-facing features.
 */
export interface ConfigV2 {
  configVersion: string;
  
  // Core infrastructure sections
  piMatrixIdentity: PiMatrixIdentityConfig;
  piMatrixConnection: PiMatrixConnectionConfig;
  piMatrixRoom: PiMatrixRoomConfig;
  piMatrixLogging: MatrixLoggingConfig;
  piMatrixThreading: PiMatrixThreadingConfig;
  piMatrixSubagents: PiMatrixSubagentsConfig;
  piTerminalUi: PiTerminalUiConfig;
  
  // Feature sections (each with enabled toggle)
  piTerminalMatrixLoginCommand: PiTerminalMatrixLoginCommandConfig;
  piMatrixMessageFormatting: PiMatrixMessageFormattingConfig;
  sendMilestones: SendMilestonesConfig;
  sendUserMessages: SendUserMessagesConfig;
  sendFinalMessages: SendFinalMessagesConfig;
  matrixToPiSlashCommands: MatrixToPiSlashCommandsConfig;
  piToMatrixMirrorAskUserQuestions: PiToMatrixMirrorAskUserQuestionsConfig;
  matrixToPiRemoteFilePicker: MatrixToPiRemoteFilePickerConfig;
  piToMatrixFileAttachment: PiToMatrixFileAttachmentConfig;
  matrixToPiVoiceTranscription: MatrixToPiVoiceTranscriptionConfig;
}

// Core infrastructure section interfaces
export interface PiMatrixIdentityConfig {
  userId?: string;
  homeserver?: string;
  credentialsPath: string;
  deviceId?: string;
  cryptoStoreDir?: string;
  storePassphrase?: string;
}

export interface PiMatrixConnectionConfig {
  autoConnect: boolean;
  syncTimeoutMs: number;
  roomId: string;
  promptConnectOnStartup: boolean;
  dedupeWindowMs: number;
  maxMessageAgeMinutes: number;
}

export interface PiMatrixRoomConfig {
  updateTopic: boolean;
  endToEndEncryption: boolean;
  attachmentEncryption: boolean;
}

export interface MatrixLoggingConfig {
  logPath: string;
  logLevel: "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";
}

export interface PiMatrixThreadSubConfig {
  enabled: boolean;
  showRolePrefixes: boolean;
  toolName: string;
}

export interface PiMatrixThreadingConfig {
  enabled: boolean;
  threadIcon: string;
  summaryCadence: number;
  useFibonacciCadence: boolean;
  summarizeOnFinalMessage: boolean;
  useLlmForSummaries: boolean;
  summarizeLimit: number;
  summarizeRunTimeoutMs: number;
  summarizeMilestoneMax: number;
  summarizeRecentMax: number;
  summarizeMaxLines: number;
  summarizeModel?: string;
  summarizeSource: "room" | "session";
  pendingRoute: "flat" | "latest";
  subThreads: PiMatrixThreadSubConfig;
}

export interface PiMatrixSubagentsConfig {
  enabled: boolean;
  postSpawnMessages: boolean;
  summarizeResultIntoSpawnLine: boolean;
  postMode: "turn-end" | "all";
  colorByType?: Record<string, string>;
  colorPalette?: string[];
  plainMarker: string;
  /** Provider dialect binding. */
  provider?: "auto" | "tintinweb" | "nicobailon";
}

export interface PiTerminalUiConfig {
  showMatrixStatus: boolean;
  matrixIcon: string;
  displayStdoutOnStartup: boolean;
}

// Feature section interfaces

export interface PiTerminalMatrixLoginCommandConfig {
  enabled: boolean;
  /** Offer the 2025 QR sign-in method (MSC4108/MSC4388). Off by default. */
  qr2025: boolean;
}

export interface PiMatrixMessageFormattingConfig {
  prefix: string;
  sendFormatted: boolean;
  sendTablesInSeparateMessages: boolean;
  maxFinalMessageLength: number;
}

export interface SendMilestonesConfig {
  enabled: boolean;
  sendSessionStartStopMilestones: boolean;
  sendCompactionMilestones: boolean;
  sendModelChangeMilestones: boolean;
  milestoneIcon: string;
}

export interface SendUserMessagesConfig {
  enabled: boolean;
  icon: string;
}

export interface SendFinalMessagesConfig {
  enabled: boolean;
}

export interface MatrixToPiSlashCommandsConfig {
  enabled: boolean;
  slashCommandPrefix: string;
}

export interface PiToMatrixMirrorAskUserQuestionsConfig {
  enabled: boolean;
  createPollsForAskUserQuestions: boolean;
}

export interface MatrixToPiRemoteFilePickerConfig {
  enabled: boolean;
  fileAttachPrefix: string;
  maxBytes: number;
  pickerLimit: number;
  fileSearchMethod: "builtin" | "fzf";
}

/** Inbound voice messages transcribed locally and injected as the sender's text. */
export interface MatrixToPiVoiceTranscriptionConfig {
  enabled: boolean;
}

export interface PiToMatrixFileAttachmentConfig {
  enabled: boolean;
  prefix: string;
  maxBytesUpload: number;
}

// =============================================================================
// DEFAULT V2 CONFIG
// =============================================================================

/** Default v2 configuration */
export const DEFAULT_CONFIG_V2: ConfigV2 = {
  configVersion: "2.0",
  
  // Core infrastructure
  piMatrixIdentity: {
    credentialsPath: "~/.config/mtx/accounts/{pi-matrix-username}--{matrix-domain}/credentials.json",
  },
  
  piMatrixConnection: {
    autoConnect: true,
    syncTimeoutMs: 30000,
    roomId: "#{room-name}:{matrix-server-domain}",
    promptConnectOnStartup: true,
    dedupeWindowMs: 600000,
    maxMessageAgeMinutes: 30
  },
  
  piMatrixRoom: {
    updateTopic: false,
    endToEndEncryption: true,
    attachmentEncryption: true
  },
  
  piMatrixLogging: {
    logPath: ".pi/matrix/logs/pi-matrix.log",
    logLevel: "INFO"
  },
  
  piMatrixThreading: {
    enabled: true,
    threadIcon: "🧵",
    summaryCadence: 10,
    useFibonacciCadence: true,
    summarizeOnFinalMessage: true,
    useLlmForSummaries: true,
    summarizeLimit: 40,
    summarizeRunTimeoutMs: 1_800_000,
    summarizeMilestoneMax: 8,
    summarizeRecentMax: 5,
    summarizeMaxLines: 25,
    summarizeSource: "room",
    pendingRoute: "flat",
    subThreads: {
      enabled: false,
      showRolePrefixes: true,
      toolName: "subagent"
    }
  },
  
  piMatrixSubagents: {
    enabled: true,
    postSpawnMessages: true,
    summarizeResultIntoSpawnLine: true,
    postMode: "turn-end",
    plainMarker: "⚡",
    provider: "tintinweb"
  },
  
  piTerminalUi: {
    showMatrixStatus: true,
    matrixIcon: "💬",
    displayStdoutOnStartup: false
  },
  
  // Feature sections
  piTerminalMatrixLoginCommand: {
    enabled: true,
    qr2025: false
  },
  
  piMatrixMessageFormatting: {
    prefix: "[Matrix] ",
    sendFormatted: true,
    sendTablesInSeparateMessages: false,
    maxFinalMessageLength: 8000
  },
  
  sendMilestones: {
    enabled: true,
    sendSessionStartStopMilestones: true,
    sendCompactionMilestones: true,
    sendModelChangeMilestones: true,
    milestoneIcon: "🎯"
  },
  
  sendUserMessages: {
    enabled: true,
    icon: "🧑"
  },
  
  sendFinalMessages: {
    enabled: true
  },
  
  matrixToPiSlashCommands: {
    enabled: true,
    slashCommandPrefix: "/"
  },
  
  piToMatrixMirrorAskUserQuestions: {
    enabled: true,
    createPollsForAskUserQuestions: true
  },
  
  matrixToPiRemoteFilePicker: {
    enabled: false,
    fileAttachPrefix: "@",
    maxBytes: 200000,
    pickerLimit: 10,
    fileSearchMethod: "builtin"
  },
  
  piToMatrixFileAttachment: {
    enabled: false,
    prefix: "@@",
    maxBytesUpload: 25000000
  },

  matrixToPiVoiceTranscription: {
    enabled: true
  }
};

// =============================================================================
// MIGRATION FUNCTION
// =============================================================================

/**
 * Migrate v1 config to v2 config.
 * This is a clean migration - old unused keys are not preserved.
 */
/**
 * A v1 `.json` file as it actually sits on disk: the flat keys still in
 * MatrixConfig (inherited below) plus the names old files carry, which
 * MatrixConfig dropped when v2 renamed them.
 *
 * Declaring them is the point. With the parameter typed as today's config, the
 * ten historical spellings went through an untyped hole — and a value nobody
 * declared is a value nobody checked. That hole is where two reviews' worth of
 * conversion bugs came from: one review found `logLevel` hardcoded into the
 * migration, the next found the v1 milestone spellings simply never read. Each
 * entry below says what it becomes, because the only check that can verify a
 * rename is this list plus the executed conversion (test/config-migration.mjs).
 */
export interface V1FileConfig extends Partial<MatrixConfig> {
  /** -> piMatrixMessageFormatting.prefix */
  messagePrefix?: string;
  /** -> piMatrixMessageFormatting.maxFinalMessageLength */
  finalMessageMaxLength?: number;
  /** -> piToMatrixFileAttachment.maxBytesUpload */
  mediaAttachMaxBytes?: number;
  /** -> sendUserMessages.icon */
  broadcastUserMessageIcon?: string;
  /** -> sendMilestones.sendSessionStartStopMilestones */
  sendSessionMilestones?: boolean;
  /** -> sendMilestones.sendCompactionMilestones */
  sendCompactMilestones?: boolean;
  /** -> sendMilestones.sendModelChangeMilestones */
  sendModelMilestones?: boolean;
  /** -> matrixToPiRemoteFilePicker.fileSearchMethod */
  artifactSearch?: string;
  /** -> piToMatrixFileAttachment.enabled (the outbound `@@` attach) */
  artifactAttach?: boolean;
  /** -> piToMatrixFileAttachment.prefix */
  artifactAttachPrefix?: string;
  /* Name collisions with today's flat keys, inherited above and re-read here
   * with their v1 meaning: `fileAttach` in a v1 file is the `@` picker toggle
   * (-> matrixToPiRemoteFilePicker.enabled), while the flat v2 key of the same
   * name is the outbound attach; `fileAttachPrefix` is the picker prefix
   * (-> matrixToPiRemoteFilePicker.fileAttachPrefix), while the v2 key of the
   * same name is the outbound prefix. test/config-migration.mjs asserts the two
   * features do not swap places. */
}

export function migrateV1toV2(oldConfig: Partial<V1FileConfig>): ConfigV2 {
  const v2: ConfigV2 = {
    configVersion: "2.0",
    
    // Core infrastructure
    piMatrixIdentity: {
      userId: oldConfig.userId,
      homeserver: oldConfig.homeserver,
      credentialsPath: oldConfig.credentialsPath ?? 
        "~/.config/mtx/accounts/{pi-matrix-username}--{matrix-domain}/credentials.json",
      deviceId: oldConfig.deviceId,
      cryptoStoreDir: oldConfig.cryptoStoreDir,
      storePassphrase: oldConfig.storePassphrase
    },
    
    piMatrixConnection: {
      autoConnect: oldConfig.autoConnect ?? true,
      syncTimeoutMs: oldConfig.syncTimeoutMs ?? 30000,
      roomId: oldConfig.roomId ?? "#{room-name}:{matrix-server-domain}",
      promptConnectOnStartup: oldConfig.promptConnectOnStartup ?? true,
      dedupeWindowMs: oldConfig.dedupeWindowMs ?? 600000,
      maxMessageAgeMinutes: oldConfig.maxMessageAgeMinutes ?? 30
    },
    
    piMatrixRoom: {
      updateTopic: oldConfig.roomTopicUpdates ?? false,
      endToEndEncryption: oldConfig.e2ee === "off" ? false : true,
      attachmentEncryption: oldConfig.attachEncryption === "off" ? false : true
    },
    
    piMatrixLogging: {
      logPath: oldConfig.logPath ?? ".pi/matrix/logs/pi-matrix.log",
      logLevel: oldConfig.logLevel ?? "INFO"
    },
    
    piMatrixThreading: {
      enabled: oldConfig.threads ?? true,
      threadIcon: oldConfig.threadIcon ?? "🧵",
      summaryCadence: oldConfig.threadSummaryEvery ?? 10,
      useFibonacciCadence: oldConfig.threadSummaryFib ?? true,
      summarizeOnFinalMessage: oldConfig.threadSummaryOnFinal ?? true,
      useLlmForSummaries: oldConfig.threadSummaryByLlm ?? true,
      summarizeLimit: oldConfig.threadSummarizeLimit ?? 40,
      summarizeRunTimeoutMs: oldConfig.threadSummarizeRunTimeoutMs ?? 1_800_000,
      summarizeMilestoneMax: oldConfig.threadSummarizeMilestoneMax ?? 8,
      summarizeRecentMax: oldConfig.threadSummarizeRecentMax ?? 5,
      summarizeMaxLines: oldConfig.threadSummarizeMaxLines ?? 25,
      summarizeModel: oldConfig.threadSummarizeModel,
      summarizeSource: oldConfig.threadSummarizeSource ?? "room",
      pendingRoute: oldConfig.threadPendingRoute ?? "flat",
      subThreads: {
        enabled: oldConfig.subThreads ?? false,
        showRolePrefixes: oldConfig.rolePrefixes ?? true,
        toolName: oldConfig.subagentToolName ?? "subagent"
      }
    },
    
    piMatrixSubagents: {
      enabled: oldConfig.subagents?.enabled ?? true,
      postSpawnMessages: oldConfig.subagents?.spawnMessages ?? true,
      summarizeResultIntoSpawnLine: oldConfig.subagents?.summarizeResultIntoSpawnLine ?? true,
      postMode: oldConfig.subagents?.postMode ?? "turn-end",
      colorByType: oldConfig.subagents?.colorByType,
      colorPalette: oldConfig.subagents?.colorPalette,
      plainMarker: oldConfig.subagents?.plainMarker ?? "⚡",
      provider: oldConfig.subagents?.provider ?? "tintinweb"
    },
    
    piTerminalUi: {
      showMatrixStatus: oldConfig.showInFooter ?? true,
      matrixIcon: oldConfig.footerIcon ?? "💬",
      displayStdoutOnStartup: oldConfig.displayStdoutOnStartup ?? false
    },
    
    // Feature sections
    piTerminalMatrixLoginCommand: {
      enabled: oldConfig.matrixLoginEnabled ?? true,
      qr2025: oldConfig.qr2025 ?? false
    },
    
    piMatrixMessageFormatting: {
      prefix: oldConfig.messagePrefix ?? "[Matrix] ",
      sendFormatted: oldConfig.sendFormatted ?? true,
      sendTablesInSeparateMessages: oldConfig.tablesInSeparateMessage ?? false,
      maxFinalMessageLength: oldConfig.finalMessageMaxLength ?? 8000
    },
    
    sendMilestones: {
      enabled: oldConfig.sendMilestones ?? true,
      // v1 spelled these ...Milestones without the StartStop/Compaction/
      // ModelChange words; read the v1 name as a fallback or a user who
      // silenced one channel gets it back after conversion.
      sendSessionStartStopMilestones: oldConfig.sendSessionStartStopMilestones ?? oldConfig.sendSessionMilestones ?? true,
      sendCompactionMilestones: oldConfig.sendCompactionMilestones ?? oldConfig.sendCompactMilestones ?? true,
      sendModelChangeMilestones: oldConfig.sendModelChangeMilestones ?? oldConfig.sendModelMilestones ?? true,
      milestoneIcon: oldConfig.milestoneIcon ?? "🎯"
    },
    
    sendUserMessages: {
      enabled: oldConfig.sendUserMessages ?? true,
      icon: oldConfig.broadcastUserMessageIcon ?? "🧑"
    },
    
    sendFinalMessages: {
      enabled: oldConfig.sendFinalMessages ?? true
    },
    
    matrixToPiSlashCommands: {
      enabled: oldConfig.slashRelay ?? true,
      slashCommandPrefix: oldConfig.slashCommandPrefix ?? "/"
    },
    
    piToMatrixMirrorAskUserQuestions: {
      enabled: oldConfig.mirrorAskUser ?? true,
      createPollsForAskUserQuestions: oldConfig.mirrorAskUserPolls ?? true
    },
    
    // NB: the v1 keys here carry v1 meanings, which differ from today's flat
    // keys — v1 `fileAttach` was the `@` picker toggle (now `remoteFilePicker`)
    // and v1 `artifactAttach` was the outbound attach (now `fileAttach`).
    matrixToPiRemoteFilePicker: {
      enabled: oldConfig.fileAttach ?? false,
      fileAttachPrefix: oldConfig.fileAttachPrefix ?? "@",
      maxBytes: oldConfig.attachMaxBytes ?? 200000,
      pickerLimit: oldConfig.pickerLimit ?? 10,
      fileSearchMethod: oldConfig.artifactSearch as "builtin" | "fzf" ?? "builtin"
    },
    
    piToMatrixFileAttachment: {
      enabled: oldConfig.artifactAttach ?? false,
      prefix: oldConfig.artifactAttachPrefix ?? "@@",
      maxBytesUpload: oldConfig.mediaAttachMaxBytes ?? 25000000
    },

    matrixToPiVoiceTranscription: {
      enabled: oldConfig.voiceTranscription ?? true
    }
  };
  
  return v2;
}

// =============================================================================
// CONFIG CONSUMER
// Single entry point for all config access
// =============================================================================

/**
 * Get the effective configuration.
 * This is the single entry point for all config access in the codebase.
 * It handles both v1 and v2 configs transparently and returns a MatrixConfig
 * that's compatible with existing code.
 *
 * Deliberately uncached. A cached copy was never invalidated by any write path
 * (login, /matrix-switch, updateConfig), so a session that wrote its config
 * kept reading the pre-write values — and one of those call sites spreads the
 * cached config as the base for its own write, which would undo the earlier
 * change. Two call sites against a ~2 KB file is not a read rate worth that bug
 * class; re-add a cache together with invalidation on write.
 */
export function getEffectiveConfig(): MatrixConfig {
  const configPath = resolveConfigPath();

  // Convert on first read: v1 .json → migrate → write .jsonc → rename .json to
  // .json.bak. Then re-read: loadConfig is the only reader, so a freshly
  // converted file goes through the same mapping path as every other config
  // (no second mapper, so the two cannot drift).
  //
  // Migrate the FILE's own values, never the merged config. loadConfig fills
  // DEFAULT_CONFIG in under the v2-era key names, and those shadow the v1
  // ancestor keys the migration reads — a user who set `sendSessionMilestones:
  // false` would silently get the channel back, because the merged object
  // already carries sendSessionStartStopMilestones: true.
  if (configPath && configPath.endsWith('.json')) {
    let fileConfig: Record<string, unknown> | null;
    try {
      fileConfig = parseJsonc(readFileSync(configPath, "utf-8"));
    } catch {
      fileConfig = null; // unreadable: fall through, loadConfig reports it
    }
    if (fileConfig && fileConfig.configVersion !== "2.0") {
      const v2 = migrateV1toV2(fileConfig as Partial<V1FileConfig>);
      const jsoncPath = configPath.replace(/\.json$/, '.jsonc');
      mkdirSync(dirname(jsoncPath), { recursive: true });
      writeFileSync(jsoncPath, JSON.stringify(v2, null, 2), 'utf-8');
      renameSync(configPath, configPath + '.bak');
      return getEffectiveConfig();
    }
  }

  return loadConfig();
}


// =============================================================================

/**
 * Convert all v1 .json config files in the config dir to v2 .jsonc.
 * For each .json file (excluding .json.bak):
 *   1. Read + parse (v1 flat or v2 nested)
 *   2. If v1: migrate to v2 nested structure
 *   3. Write as .jsonc
 *   4. Rename .json to .json.bak
 *
 * Safe to call on every startup — already-converted files are skipped.
 * ponytail: kept for config files written before v2, which is every existing
 * install. It goes together with the v1 reader, and that needs a major bump —
 * dropping it alone strands anyone still running a v1 file.
 */
export function convertAllConfigs(): number {
  const dirs = new Set<string>();
  
  // Project config dir (.pi/matrix/)
  const projectDir = join(process.cwd(), '.pi', 'matrix');
  if (existsSync(projectDir)) dirs.add(projectDir);
  
  // Extension config dir
  const extDir = getConfigDir();
  if (existsSync(extDir)) dirs.add(extDir);
  
  let totalConverted = 0;
  
  for (const dir of dirs) {
    // If any .json.bak exists in this dir, a previous conversion already ran.
    const hasBak = readdirSync(dir).some(f => f.endsWith('.json.bak'));
    if (hasBak) continue;
    
    const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('TEMPLATE.'));
    let converted = 0;
    
    for (const file of files) {
      const jsonPath = join(dir, file);
      const jsoncPath = jsonPath.replace(/\.json$/, '.jsonc');
      
      if (existsSync(jsoncPath)) {
        renameSync(jsonPath, jsonPath + '.bak');
        converted++;
        continue;
      }
      
      try {
        const content = readFileSync(jsonPath, 'utf-8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        
        if (parsed.configVersion === '2.0' && parsed.piMatrixIdentity) {
          writeFileSync(jsoncPath, JSON.stringify(parsed, null, 2), 'utf-8');
        } else {
          const v2 = migrateV1toV2(parsed as Partial<V1FileConfig>);
          writeFileSync(jsoncPath, JSON.stringify(v2, null, 2), 'utf-8');
        }
        
        renameSync(jsonPath, jsonPath + '.bak');
        converted++;
      } catch (err) {
        console.warn(`[matrix] failed to convert ${file}:`, err);
      }
    }
    
    if (converted > 0) {
      console.log(`[matrix] converted ${converted} config file(s) in ${dir}`);
    }
    totalConverted += converted;
  }
  
  return totalConverted;
}

/**
 * Build a v2 nested config object from a flat v1 config object.
 * Inverse of mapV2ToFlat — groups flat keys into v2 sections.
 */

/**
 * Seed a profile file with the defaults its sections are missing
 * (self-healing). Profiles are v2 documents now (login writes them, and
 * convertAllConfigs converts the old ones), so seeding walks each section the
 * file already carries and adds the keys it lacks. Writing flat keys at the top
 * level of a v2 file would be ignored by the v2 loader and litter the file.
 *
 * ponytail: one level deep — a section that carries a sub-object (subThreads)
 * gets the whole default only when the key is absent, not merged key by key.
 * A legacy flat `.json` profile still seeds from DEFAULT_CONFIG.
 */
export function seedProfileDefaults(name: string): string[] {
  if (name.includes("/") || name.includes("..")) return [];
  const dir = getActiveConfigDir() ?? getConfigDir();
  const jsoncPath = join(dir, `matrix-config.${name}.jsonc`);
  const path = existsSync(jsoncPath) ? jsoncPath : join(dir, `matrix-config.${name}.json`);
  if (!existsSync(path)) return [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  if (parsed.configVersion !== "2.0") return seedConfigFile(path);

  const seeded: string[] = [];
  for (const [section, defaults] of Object.entries(DEFAULT_CONFIG_V2 as unknown as Record<string, unknown>)) {
    const current = parsed[section];
    if (!defaults || typeof defaults !== "object" || !current || typeof current !== "object") continue;
    const target = current as Record<string, unknown>;
    for (const [key, value] of Object.entries(defaults as Record<string, unknown>)) {
      if (value !== undefined && !(key in target)) {
        target[key] = value;
        seeded.push(`${section}.${key}`);
      }
    }
  }
  if (seeded.length) writeFileSync(path, JSON.stringify(parsed, null, 2), "utf-8");
  return seeded;
}

/**
 * Create the project-local config when absent, seeded with all defaults but a
 * per-project credentialsPath — so /matrix-login provisions the account under
 * `~/.config/mtx/projects/<project>/` instead of the flat `accounts/` dir.
 * Never clobbers an existing file. Returns the path when created, null when the
 * project config already exists (the user's values win).
 *
 * Lives here rather than in config.ts because the file it writes is a v2
 * document, and only this module may build one. It used to write DEFAULT_CONFIG
 * (the flat v1 table) to a path named .jsonc: loadConfig still accepted it — it
 * detects the schema by content, not by extension — but nothing ever converted
 * it. convert-on-first-read only watches `.json` paths and convertAllConfigs
 * only scans `.json` files, so every new project started life as a permanent v1
 * config wearing a v2 filename. migrateV1toV2 builds the document here, which
 * is also what the login flow writes: one shape builder, not two.
 */
export function ensureProjectConfig(): string | null {
  const projectPathJson = getProjectConfigPath();
  const projectPathJsonc = projectPathJson.replace(/\.json$/, '.jsonc');

  // Either extension counts as "the project already has a config".
  if (existsSync(projectPathJson) || existsSync(projectPathJsonc)) return null;

  saveConfig(
    migrateV1toV2({ ...DEFAULT_CONFIG, credentialsPath: getProjectCredentialsPath() }),
    projectPathJsonc,
  );
  return projectPathJsonc;
}

// =============================================================================
// V1 Compatibility Functions (moved from config.ts for v2-only transition)
// =============================================================================

/**
 * Get credentials path from config or default.
 * Moved from config.ts to support v2-only transition.
 */
export function getCredentialsPath(config: MatrixConfig): string {
  return resolve(config.credentialsPath);
}

/**
 * Create default config file.
 * Moved from config.ts to support v2-only transition.
 */
export function createDefaultConfig(path?: string): string | null {
  const configPath = path ||
    join(homedir(), '.pi', 'agent', 'extensions', 'pi-matrix-integration', 'config', 'matrix-config.json');

  if (existsSync(configPath)) {
    return null;
  }

  saveConfig(DEFAULT_CONFIG, configPath);
  return configPath;
}

/**
 * Resolve startup configuration - v2 only version.
 * Uses getEffectiveConfig() which already handles v2 config resolution.
 */
export function resolveStartupConfig(): {
  config: MatrixConfig;
  valid: boolean;
  errors: string[];
  profile: string | undefined;
} {
  const name = getActiveProfileName();
  if (name) {
    const profileConfig = loadProfile(name);
    if (profileConfig.valid) {
      return { ...profileConfig, profile: name };
    }
    console.warn(
      `[matrix] config: active profile "${name}" not loadable (${profileConfig.errors.join("; ")}) — falling back to the live config`,
    );
  }
  return { ...getValidConfig(), profile: undefined };
}
