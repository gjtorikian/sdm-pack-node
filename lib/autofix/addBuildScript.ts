/*
 * Copyright © 2018 Atomist, Inc.
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
    doWithJson,
    Project,
} from "@atomist/automation-client";
import { AutofixRegistration } from "@atomist/sdm";
import * as _ from "lodash";
import { IsNode } from "../pushtest/nodePushTests";

export const AddBuildScript: AutofixRegistration = {
    name: "Make sure there is a build script",
    pushTest: IsNode,
    transform: addBuildScriptTransform,
};

export async function addBuildScriptTransform(p: Project): Promise<Project> {
    return doWithJson(p, "package.json", (packageJson => {
            if (_.get(packageJson, "scripts.build")) {
                return;
            }
            // todo: what would work on both linuxy and windows?
            return _.merge(packageJson, { scripts: { build: "echo 'The build goes here'" } });
        }
    ));
}
