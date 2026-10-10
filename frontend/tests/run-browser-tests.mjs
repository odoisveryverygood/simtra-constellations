// Start a static server for this checkout first. Uses the installed Playwright CLI.
// PLAYWRIGHT_CLI=/path/to/playwright_cli.sh SIMTRA_TEST_BASE=http://localhost:5194 node tests/run-browser-tests.mjs
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const frontend=fileURLToPath(new URL('..',import.meta.url));
const cli=process.env.PLAYWRIGHT_CLI || 'playwright-cli';
const base=process.env.SIMTRA_TEST_BASE || 'http://localhost:5173';
const output=resolve(frontend,'output/playwright');mkdirSync(output,{recursive:true});
const session='verified-data-tests';
const run=(...args)=>{
  const r=spawnSync(cli,[`-s=${session}`,...args],{cwd:frontend,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
  if(r.error||r.status!==0)throw Error(r.error || r.stderr || r.stdout);
  return r.stdout;
};
const reports=[];
try {
  for(const name of ['browser-smoke.js','browser-touch-smoke.js','browser-verified-data.js','verified-touch']){
    run('open','about:blank');
    const file=name==='verified-touch'?'browser-verified-data.js':name;
    let code=readFileSync(new URL(file,import.meta.url),'utf8').replaceAll('http://localhost:5173',base)
      .replaceAll('/tmp/simtra-integration-evidence/mobile.png',resolve(output,'simulation-mobile.png'));
    if(name==='verified-touch') {
      code=code.replaceAll('await bachelor.click()','await bachelor.tap()')
        .replace("await page.locator('#verified-combine').check()","await page.locator('#verified-combine').tap()")
        .replaceAll("await page.locator('button[data-key=\"graduate\"]').click()","await page.locator('button[data-key=\"graduate\"]').tap()");
      code=`async (page) => { const context=await page.context().browser().newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'}); const mobile=await context.newPage(); try { return await (${code})(mobile); } finally { await context.close(); } }`;
    }
    const stdout=run('run-code',code);
    const result=stdout.match(/### Result\s*([\s\S]*?)(?=\n###|$)/)?.[1];
    if(!result)throw Error(`${name}: no result: ${stdout.slice(0,2000)}`);
    const cases=JSON.parse(result);reports.push({name,cases});
    const failures=cases.filter(c=>c.status!=='passed');
    console.log(`${name}: ${cases.length-failures.length}/${cases.length} passed`);
    run('close');
    if(failures.length)throw Error(JSON.stringify(failures));
  }
} finally {
  try {run('close');}catch{}
  writeFileSync(resolve(output,'verified-browser-results.json'),JSON.stringify(reports,null,2)+'\n');
}
