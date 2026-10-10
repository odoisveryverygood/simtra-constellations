// Run with Playwright CLI against the local fixture-server helper and this checkout.
// /data-query and resident creation use the actual Rust backend, not saved responses.
async (page) => {
  const base='http://localhost:5194', api='http://localhost:5188';
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const cases=[], errors=[], requests=[];
  await page.unrouteAll({behavior:'ignoreErrors'});
  page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/*',async route=>{
    const url=route.request().url();
    if(url.startsWith(base+'/')) return route.continue();
    if(url.startsWith(api+'/')) {
      requests.push(url.slice(api.length).split('?')[0]);
      check(!/\/parse$|\/poll$|\/branches$/.test(url),'no prediction calls');
      if(url===api+'/simulations') {
        const data=route.request().postDataJSON();
        return route.continue({postData:JSON.stringify({...data,n:256})});
      }
      return route.continue();
    }
    return route.fulfill({status:200,contentType:'text/css',body:''});
  });
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(base+'/?backend=local&port=5188');
  await page.waitForFunction(async()=> (await import('/src/app.js')).state.phase==='idle');
  await page.getByRole('radio',{name:'Verified data',exact:true}).check();
  async function ask(question) {
    if(await page.getByRole('button',{name:'Dismiss',exact:true}).isVisible()) await page.getByRole('button',{name:'Dismiss',exact:true}).click();
    await page.getByRole('group',{name:'Ask a verified data question'}).click();
    await page.getByRole('textbox',{name:'Verified data question',exact:true}).fill(question);
    const pending=page.waitForResponse(r=>r.url()===api+'/data-query');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    const response=await (await pending).json();
    await page.locator('#verified-heading').waitFor();
    return response;
  }
  for(const [question,key] of [['Show the education distribution','bachelors'],['Show the age distribution','25-34']]) {
    await page.setViewportSize({width:1440,height:1000});
    const response=await ask(question);
    check(response.status==='ok','backend accepted '+question);
    check(await page.locator('.verified-answer').innerText()===response.answer,'actual answer rendered');
    check((await page.locator('#verified-panel').innerText()).includes('Verified source data'),'provenance verified');
    check(await page.locator('.verified-bars button').count()===response.chart.series.length,'all chart bars');
    const bar=page.locator(`.verified-bars button[data-key="${key}"]`);
    await bar.click();
    const result=await page.evaluate(async({dimension,key})=>{
      const {map,state}=await import('/src/app.js');
      const residents=state.rawResidents;
      const expected=residents.filter(r=>r.segments[dimension]===key).length;
      map.returnToOverview();map._draw(performance.now());
      const c=map.ctx,original=c.strokeRect;let green=0;
      c.strokeRect=function(...args){if(this.strokeStyle==='#22c55e')green++;return original.apply(this,args);};
      try{map._drawSprites(performance.now(),0);}finally{c.strokeRect=original;}
      return {expected,green,total:residents.length,summary:map.getSegmentSelectionSummary(),text:document.querySelector('[data-verified-summary]').textContent};
    },{dimension:response.query_spec.group_by,key});
    check(result.expected>0&&result.summary.rawMatchingAgents===result.expected,'exact matching residents');
    check(result.green===result.expected,'actual green canvas outlines: '+JSON.stringify(result));
    const row=response.chart.series.find(r=>r.key===key);
    for(const label of [`Full PUMS weighted estimate: ${row.weighted_population.toLocaleString('en-US')}`,`Full PUMS raw-record count: ${row.raw_records.toLocaleString('en-US')}`,`Matching synthetic-map resident count: ${result.expected}`])check(result.text.includes(label),'separate count '+label);
    await bar.focus();await page.keyboard.press('Escape');
    check(await bar.getAttribute('aria-pressed')==='false','Escape clears');
    await bar.focus();await page.keyboard.press('Space');
    check(await bar.getAttribute('aria-pressed')==='true','Space selects');
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    check(await page.evaluate(()=>document.activeElement.getAttribute('aria-pressed'))==='true','arrow and Enter');
    await page.setViewportSize({width:390,height:844});
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=390),'mobile no overflow');
    await page.screenshot({path:`output/playwright/actual-${response.query_spec.group_by}-mobile.png`});
    cases.push({question,status:'passed',bars:response.chart.series.length,pumsWeighted:response.method.weighted_population,pumsRecords:response.method.raw_records,selectedKey:key,selectedWeighted:row.weighted_population,selectedRecords:row.raw_records,syntheticMatching:result.expected,syntheticTotal:result.total,greenOutlines:result.green});
  }
  const response=await ask('Who will win the next election?');
  check(response.status==='unsupported'&&response.answer===null,'unsupported no answer');
  check(await page.locator('.verified-bars').count()===0,'unsupported no chart');
  check((await page.locator('#verified-panel').innerText()).includes('This question cannot be verified with the available datasets'),'honest unsupported message');
  check(errors.length===0,errors.join(';'));
  cases.push({question:response.question,status:'passed',answer:response.answer,bars:0});
  return {cases,errors,dataQueryRequests:requests.filter(p=>p==='/data-query').length};
}
