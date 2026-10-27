/**
 * The one model-ID glob matcher shared by `models[].match` and
 * `include_models`: standard minimatch semantics (`*`/`?` stay inside one
 * `/` segment, `**` spans segments, classes and braces, dot segments match,
 * leading `!`/`#` are literal, case-sensitive). Matching runs only on the
 * host thread: the compile Worker receives precomputed rule indices and never
 * imports minimatch (bare specifiers do not resolve inside a Worker in the
 * Bun-compiled Pi host).
 */
import { Minimatch } from "minimatch";

import {
  MetadataConfigError,
  type HiddenModel,
  type MetadataConfig,
  type ModelSelection,
} from "./model-metadata.ts";

export const MODEL_GLOB_OPTIONS = Object.freeze({ nonegate: true, nocomment: true, dot: true });

/** Compiles one glob; a pattern minimatch cannot compile is a config error at `path`. */
export function compileModelPattern(glob: string, path: string): Minimatch {
  const matcher = new Minimatch(glob, MODEL_GLOB_OPTIONS);
  if (matcher.makeRe() === false) throw new MetadataConfigError(path, `invalid glob ${JSON.stringify(glob)}`);
  return matcher;
}

/** One-off match of a glob against a full public id. */
export function modelGlobMatches(glob: string, id: string): boolean {
  return new Minimatch(glob, MODEL_GLOB_OPTIONS).match(id);
}

/** For each public id, the 0-based `config.models` indices whose `match` hits it. */
export function matchRules(config: MetadataConfig, publicIds: readonly string[]): number[][] {
  const rules = (config.models ?? []).map((rule) => new Minimatch(rule.match, MODEL_GLOB_OPTIONS));
  return publicIds.map((id) => rules.flatMap((matcher, index) => (matcher.match(id) ? [index] : [])));
}

/**
 * Applies `include_models`: the last matching entry decides (`!` hides),
 * unmatched ids are hidden, an absent list keeps everything. Id order is
 * preserved. Runs before compilation so hidden ids are never processed.
 */
export function selectModels(config: MetadataConfig, publicIds: readonly string[]): ModelSelection {
  const rules = config.includeModels;
  if (rules === undefined) return { kept: [...publicIds], hidden: [] };
  const matchers = rules.map((rule) => new Minimatch(rule.glob, MODEL_GLOB_OPTIONS));
  const kept: string[] = [];
  const hidden: HiddenModel[] = [];
  for (const id of publicIds) {
    let decided = -1;
    for (let index = matchers.length - 1; index >= 0; index--) {
      if (matchers[index].match(id)) {
        decided = index;
        break;
      }
    }
    if (decided >= 0 && !rules[decided].exclude) kept.push(id);
    else hidden.push(decided < 0 ? { id, ruleIndex: null } : { id, ruleIndex: decided, pattern: rules[decided].raw });
  }
  return { kept, hidden };
}
