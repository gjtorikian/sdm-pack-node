/*
 * Copyright © 2019 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    GitProject,
    guid,
    LocalProject,
    Project,
    RemoteRepoRef,
} from "@atomist/automation-client";
import {
    AppInfo,
    ExecuteGoalResult,
    GoalInvocation,
    GoalProjectListenerEvent,
    GoalProjectListenerRegistration,
    spawnLog,
    SpawnLogCommand,
    SpawnLogOptions,
    SpawnLogResult,
    SuccessIsReturn0ErrorFinder,
} from "@atomist/sdm";
import { readSdmVersion } from "@atomist/sdm-core";
import {
    Builder,
    spawnBuilder,
    SpawnBuilderOptions,
} from "@atomist/sdm-pack-build";
import base64url from "base64url";
import * as fs from "fs-extra";
import * as hash from "hasha";
import * as _ from "lodash";
import { IsNode } from "../pushtest/nodePushTests";
import { PackageJson } from "../util/PackageJson";
import { NpmLogInterpreter } from "./npmLogInterpreter";

/**
 * Options to use when running node commands like npm run compile that require dev dependencies to be installed
 */
export const DevelopmentEnvOptions: SpawnLogOptions = {
    env: {
        ...process.env,
        NODE_ENV: "development",
    },
} as any;

export const Install: SpawnLogCommand = { command: "npm", args: ["ci"], options: DevelopmentEnvOptions };

export function nodeBuilder(...commands: SpawnLogCommand[]): Builder {
    return spawnBuilder(npmBuilderOptions(commands.map(cmd => ({
        command: cmd.command, args: cmd.args, options: {
            ...DevelopmentEnvOptions,
            ...cmd.options,
        },
    }))));
}

function npmBuilderOptions(commands: SpawnLogCommand[]): SpawnBuilderOptions {
    return {
        name: "NpmBuilder",
        commands,
        errorFinder: SuccessIsReturn0ErrorFinder,
        logInterpreter: NpmLogInterpreter,
        // tslint:disable-next-line:deprecation
        async projectToAppInfo(p: Project): Promise<AppInfo> {
            const packageJson = await p.findFile("package.json");
            const content = await packageJson.getContent();
            const pkg = JSON.parse(content);
            return { id: p.id as RemoteRepoRef, name: pkg.name, version: pkg.version };
        },
    };
}

export function npmBuilderOptionsFromFile(commandFile: string): SpawnBuilderOptions {
    return {
        name: "NpmBuilder",
        commandFile,
        errorFinder: (code, signal, l) => {
            return l.log.startsWith("[error]") || l.log.includes("ERR!");
        },
        logInterpreter: NpmLogInterpreter,
        // tslint:disable-next-line:deprecation
        async projectToAppInfo(p: Project): Promise<AppInfo> {
            const packageJson = await p.findFile("package.json");
            const content = await packageJson.getContent();
            const pkg = JSON.parse(content);
            return { id: p.id as RemoteRepoRef, name: pkg.name, version: pkg.version };
        },
    };
}

export const NpmPreparations = [npmInstallPreparation, npmVersionPreparation, npmCompilePreparation];

export async function npmInstallPreparation(p: GitProject, goalInvocation: GoalInvocation): Promise<ExecuteGoalResult> {
    const hasPackageLock = p.fileExistsSync("package-lock.json");
    return spawnLog(
        "npm",
        [hasPackageLock ? "ci" : "install"],
        {
            cwd: p.baseDir,
            ...DevelopmentEnvOptions,
            log: goalInvocation.progressLog,
        });
}

export async function npmVersionPreparation(p: GitProject, goalInvocation: GoalInvocation): Promise<ExecuteGoalResult> {
    const sdmGoal = goalInvocation.goalEvent;
    const version = await readSdmVersion(
        sdmGoal.repo.owner,
        sdmGoal.repo.name,
        sdmGoal.repo.providerId,
        sdmGoal.sha,
        sdmGoal.branch,
        goalInvocation.context);
    return spawnLog(
        "npm",
        ["--no-git-tag-version", "version", version],
        {
            cwd: p.baseDir,
            log: goalInvocation.progressLog,
        });
}

export const NpmVersionProjectListener: GoalProjectListenerRegistration = {
    name: "npm version",
    pushTest: IsNode,
    listener: async (p, r, event): Promise<void | ExecuteGoalResult> => {
        if (GoalProjectListenerEvent.before === event) {
            return npmVersionPreparation(p, r);
        }
    },
};

export async function npmCompilePreparation(p: GitProject, goalInvocation: GoalInvocation): Promise<ExecuteGoalResult> {
    if (await hasCompileScriptInPackageJson(p)) {
        return spawnLog(
            "npm",
            ["run", "compile"],
            {
                cwd: p.baseDir,
                ...DevelopmentEnvOptions,
                log: goalInvocation.progressLog,
            });
    } else {
        return { code: 0 };
    }
}

async function hasCompileScriptInPackageJson(p: LocalProject): Promise<boolean> {
    const rawPj = await p.getFile("package.json");
    const pj: PackageJson = JSON.parse(await rawPj.getContent()) as PackageJson;
    return !!pj.scripts && !!pj.scripts.compile;
}

export const NpmCompileProjectListener: GoalProjectListenerRegistration = {
    name: "npm compile",
    pushTest: IsNode,
    listener: async (p, r): Promise<void | ExecuteGoalResult> => {
        return npmCompilePreparation(p, r);
    },
    events: [GoalProjectListenerEvent.before],
};

export const NodeModulesProjectListener: GoalProjectListenerRegistration = {
    name: "npm install",
    listener: async (p, gi) => {
        // Check if project has a package.json
        if (!(await p.hasFile("package.json"))) {
            return;
        }
        return cacheNodeModules(p, gi, { scope: CacheScope.GoalSet });
    },
    events: [GoalProjectListenerEvent.before],
    pushTest: IsNode,
};
export const NpmInstallProjectListener = NodeModulesProjectListener;

export function npmInstallProjectListener(options: { scope: CacheScope } = { scope: CacheScope.GoalSet })
    : GoalProjectListenerRegistration {
    return {
        name: "npm install",
        listener: async (p, gi) => {
            // Check if project has a package.json
            if (!(await p.hasFile("package.json"))) {
                return;
            }
            return cacheNodeModules(p, gi, options);
        },
        events: [GoalProjectListenerEvent.before],
        pushTest: IsNode,
    };
}

export enum CacheScope {
    GoalSet,
    Repository,
}

async function cacheNodeModules(p: GitProject,
                                gi: GoalInvocation,
                                options: { scope: CacheScope }): Promise<void | ExecuteGoalResult> {
    // If project already has a node_modules dir; there is nothing left to do
    if (await p.hasDirectory("node_modules")) {
        return;
    }

    const hasPackageLock = await p.hasFile("package-lock.json");

    let requiresInstall = true;
    let installed = false;

    const { goalEvent } = gi;

    // Check cache for a previously cached node_modules cache archive
    let name: string;
    if (options.scope === CacheScope.GoalSet) {
        name = goalEvent.goalSetId;
    } else if (options.scope === CacheScope.Repository) {
        if (hasPackageLock) {
            name = base64url.fromBase64(hash(await (await p.getFile("package-lock.json")).getContent(), {
                algorithm: "md5",
                encoding: "base64",
            }));
        } else {
            name = base64url.fromBase64(hash(await (await p.getFile("package.json")).getContent(), {
                algorithm: "md5",
                encoding: "base64",
            }));
        }
    }

    const cacheFileName = `${_.get(gi, "configuration.sdm.cache.path",
        "/opt/data")}/${name}-node_modules.tar.gz`;
    if (_.get(gi, "configuration.sdm.cache.enabled") === true && (await fs.pathExists(cacheFileName))) {
        const result = await extract(cacheFileName, p, gi);
        requiresInstall = result.code !== 0;
    }

    if (requiresInstall) {
        let result;
        if (hasPackageLock) {
            result = await runInstall("ci", p, gi);
        } else {
            result = await runInstall("i", p, gi);
        }
        installed = result.code === 0;
    }

    // Cache the node_modules folder
    if (installed && _.get(gi, "configuration.sdm.cache.enabled") === true) {
        const tempCacheFileName = `${cacheFileName}.${guid().slice(0, 7)}`;
        const result = await compress(tempCacheFileName, p, gi);
        if (result.code === 0) {
            await fs.move(tempCacheFileName, cacheFileName, { overwrite: true });
        }
    }
}

async function runInstall(cmd: string,
                          p: GitProject,
                          gi: GoalInvocation): Promise<SpawnLogResult> {
    return spawnLog(
        "npm",
        [cmd],
        {
            cwd: p.baseDir,
            env: {
                ...process.env,
                NODE_ENV: "development",
            },
            log: gi.progressLog,
        });
}

async function compress(name: string,
                        p: GitProject,
                        gi: GoalInvocation): Promise<SpawnLogResult> {
    return spawnLog(
        "tar",
        ["-zcf", name, "node_modules"],
        {
            cwd: p.baseDir,
            log: gi.progressLog,
        });
}

async function extract(name: string,
                       p: GitProject,
                       gi: GoalInvocation): Promise<SpawnLogResult> {
    return spawnLog(
        "tar",
        ["-xf", name],
        {
            cwd: p.baseDir,
            log: gi.progressLog,
        });
}
