import "./setup.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { replaceResourceRecordSync } from "../scripts/studio-resource-record.ts";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runWindowsProcessGroup } from "../modules/studio/backend/windows-process-group.ts";

test("资源观察仍计算父进程已退出但留在同一Job内的活跃后代", { timeout: 25_000 }, async () => {
  await mkdir(".local", { recursive: true });
  const folder = await mkdtemp(path.resolve(".local/resources-descendants-"));
  const configuration = path.join(folder, "config.env"), script = path.join(folder, "observe.mjs");
  const marker = path.join(folder, "descendant.json"), resultFile = path.join(folder, "result.json");
  const ownershipFile = path.join(folder, "ownership.json"), ownershipId = "a".repeat(64);
  const grandson = `const held=Buffer.alloc(64*1024*1024,1);require('node:fs').writeFileSync(process.argv[1],JSON.stringify(process.pid));setTimeout(()=>{console.log(held[0])},30000);`;
  const parent = `const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandson)},process.argv[1]],{stdio:'ignore',detached:true,windowsHide:true});p.unref();`;
  let verified = false;
  let publicationCode: string | undefined;
  try {
    await writeFile(configuration, `DATABASE_URL=${process.env.DATABASE_URL}\n`);
    await writeFile(script, `import {spawn} from 'node:child_process';import {once} from 'node:events';
      import {readFile,writeFile} from 'node:fs/promises';import {existsSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
      import {readLocalConfiguration} from ${JSON.stringify(pathToFileURL(path.resolve("scripts/studio-config.ts")).href)};
      import {inspectApplicationResources} from ${JSON.stringify(pathToFileURL(path.resolve("modules/studio/backend/application-resources.ts")).href)};
      const {env}=await readLocalConfiguration(process.argv[2]);
      const ownership={file:${JSON.stringify(ownershipFile)},id:${JSON.stringify(ownershipId)}};
      const before=await inspectApplicationResources(env.DATABASE_URL,ownership);
      const child=spawn(process.execPath,['-e',${JSON.stringify(parent)},${JSON.stringify(marker)}],{stdio:'ignore',windowsHide:true});
      await once(child,'exit');const deadline=Date.now()+4000;
      while(!existsSync(${JSON.stringify(marker)})){if(Date.now()>deadline)throw Error('descendant not ready');await delay(25)}
      process.kill(JSON.parse(await readFile(${JSON.stringify(marker)},'utf8')),0);
      const after=await inspectApplicationResources(env.DATABASE_URL,ownership);
      await writeFile(${JSON.stringify(resultFile)},JSON.stringify({before,after}));`);
    const result = await runWindowsProcessGroup({ executable: process.execPath, args: [script, configuration], cwd: path.resolve("."),
      cpuPercent: 25, memoryLimitBytes: 1024 ** 3, onStatus: status => {
        try {
          const temporary = ownershipFile + ".tmp";
          writeFileSync(temporary, JSON.stringify({ id: ownershipId, updatedAt: Date.now(), status: { type: "status", ...status } }));
          replaceResourceRecordSync(temporary, ownershipFile);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          publicationCode = ["EACCES", "EPERM", "EBUSY", "ENOSPC", "EIO"].includes(code ?? "") ? code : "UNKNOWN";
          throw error;
        }
      } }).catch(error => {
        if (publicationCode) throw new Error(`夹具所有权状态发布失败（${publicationCode}），保留现场；未改退出策略`);
        throw error;
      });
    assert.equal(result.exitCode, 0);
    const { before, after } = JSON.parse(await readFile(resultFile, "utf8"));
    assert.equal(before.state, "measured"); assert.equal(after.state, "measured");
    assert.ok(after.components[0].processes >= before.components[0].processes + 1, "父进程退出后新增的活跃后代仍须计入，不能被观察器附属进程凑数");
    const descendantPid = JSON.parse(await readFile(marker, "utf8"));
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
    verified = true;
  } finally {
    assert.ok(folder.startsWith(path.resolve(".local") + path.sep));
    if (verified) await rm(folder, { recursive: true, force: true });
  }
});
