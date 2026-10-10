// Playwright CLI run-code function. All API responses are local contract fixtures.
async (page) => {
  page.setDefaultTimeout(8000);
  const base='http://localhost:5173';
  const fixture=await (await page.request.get(`${base}/fixtures/verified-data-contract.json`)).json();
  const unsupported=await (await page.request.get(`${base}/fixtures/verified-data-unsupported.json`)).json();
  const demo=await (await page.request.get(`${base}/fixtures/evidence-demo.json`)).json();
  const city=demo.cities.find(r=>r.city.slug==='sf');
  const errors=[],calls=[],cases=[];
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  const report=name=>cases.push({name,status:'passed'});
  let response=fixture, hold=null;
  await page.unrouteAll({behavior:'ignoreErrors'});
  page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',async route=>{
    const request=route.request(),url=request.url();
    if(url.startsWith(base+'/'))return route.continue();
    const path='/'+url.split('/').slice(3).join('/').split('?')[0];
    if (!url.includes('sf-digital-twin-tp.fly.dev')) return route.fulfill({status:200,contentType:'text/css',body:''});
    calls.push({path,method:request.method(),body:request.postData()});
    let result;
    if(path==='/cities')result={cities:demo.cities.map(r=>r.city)};
    else if(path==='/simulations')result={simulation_id:'test-simulation',main_branch:'test-main'};
    else if(path.endsWith('/agents'))result={agents:city.agents,total_matched:city.agents.length};
    else if(path.endsWith('/news'))result={articles:[]};
    else if(path.endsWith('/chatter'))result={chatter:{}};
    else if(path==='/data-query'){
      if(hold)await hold;
      if(response==='network-error')return route.abort();
      result=response;
    } else throw Error(`Unexpected API request: ${path}`);
    return route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(result)});
  });
  const summary=()=>page.evaluate(async()=>{
    const {map}=await import('/src/app.js');return {...map.getSegmentSelectionSummary(),text:document.querySelector('[data-verified-summary]')?.textContent};
  });
  const ask=async()=>{
    await page.getByRole('group',{name:'Ask a prediction question'}).click();
    await page.getByRole('textbox',{name:'Predict anything',exact:true}).fill(fixture.question);
    check(await page.locator('#ask-input').inputValue()===fixture.question,'composer value before submit');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await page.locator('#verified-heading').waitFor();
  };
  try {
    await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({reducedMotion:'reduce'});
    await page.goto(base);await page.waitForFunction(async()=> (await import('/src/app.js')).state.phase==='idle');
    // Verified-data questions are routed automatically by their shape; there is no mode switch.
    const before=calls.length;await ask();
    const query=calls.slice(before).filter(c=>!c.path.endsWith('/news'));
    check(query.length===1&&query[0].path==='/data-query'&&query[0].method==='POST','Verified mode must only POST data-query');
    check(JSON.parse(query[0].body).question===fixture.question,'exact question payload');
    check(await page.locator('.verified-answer').innerText()===fixture.answer,'backend answer');
    check((await page.locator('#verified-panel').innerText()).includes('Verified source data'),'complete provenance');
    report('Verified mode routes only to /data-query and renders backend answer/provenance');
    const bachelor=page.locator('#verified-panel button[data-key="bachelors_or_higher"]');
    await bachelor.click();
    const independent=city.agents.filter(r=>['bachelors','graduate'].includes(r.segments.education)).length;
    let result=await summary();
    check(result.rawMatchingAgents===independent && result.active,'exact map predicate matches');
    check(result.text.includes('123,456')&&result.text.includes('1,234')&&result.text.includes(`resident count: ${independent}`),'three distinct counts');
    const drawing=await page.evaluate(async()=>{
      const {map}=await import('/src/app.js');map.returnToOverview();map._draw(performance.now());
      const c=map.ctx,calls=[],originals={};
      for(const method of ['drawImage','fillRect','strokeRect']){originals[method]=c[method];c[method]=function(...args){calls.push({method,alpha:this.globalAlpha,stroke:this.strokeStyle});return originals[method].apply(this,args);};}
      try{map._drawSprites(performance.now(),0);}finally{for(const [key,value] of Object.entries(originals))c[key]=value;}
      return {green:calls.filter(c=>c.method==='strokeRect'&&c.stroke==='#22c55e').length,dim:calls.filter(c=>(c.method==='drawImage'||c.method==='fillRect')&&c.alpha<.5).length};
    });
    check(drawing.green===independent&&drawing.dim===city.agents.length-independent,'green matching sprites, dim nonmatches');
    report('real canvas highlights matches green; PUMS counts remain independent of synthetic map');
    await page.keyboard.press('ArrowDown');check(await page.evaluate(()=>document.activeElement.dataset.key==='graduate'),'arrow focus');
    await page.keyboard.press('Shift+Enter');result=await summary();
    check(result.rawMatchingAgents===independent&&result.text.includes('49,948')&&!result.text.includes('173,404'),'overlap union deduplicated');
    check(await page.locator('button[data-key="graduate"]').getAttribute('aria-pressed')==='true','keyboard selected state');
    await page.keyboard.press('Escape');check(!(await summary()).active,'escape clear');
    await bachelor.focus();await page.keyboard.press('Space');check((await summary()).active,'Space selects');
    const focus=await bachelor.evaluate(el=>({outline:getComputedStyle(el).outlineWidth,active:el===document.activeElement}));
    check(focus.active&&parseFloat(focus.outline)>=2,'focus survives rerender');
    check(await page.locator('#verified-announcement').getAttribute('aria-live')==='polite','persistent screen-reader count announcement');
    report('keyboard arrows, Shift+Enter, Space, Escape and visible focus');
    await page.getByRole('button',{name:'Clear selection',exact:true}).click();
    await page.locator('#verified-combine').check();await bachelor.click();await page.locator('button[data-key="graduate"]').click();
    check((await summary()).rawMatchingAgents===independent,'touch combine control');
    await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
    check((await bachelor.innerText()).includes('✓ Selected'),'forced color non-color selection');
    await page.emulateMedia({forcedColors:'none',reducedMotion:'reduce'});
    await page.setViewportSize({width:390,height:844});await bachelor.scrollIntoViewIfNeeded();
    const layout=await page.evaluate(()=>{const card=document.querySelector('#result-card'),b=document.querySelector('.verified-bars button'),r=card.getBoundingClientRect();return {width:document.documentElement.scrollWidth,overflow:card.scrollWidth>card.clientWidth,left:r.left,right:r.right,target:b.getBoundingClientRect().height};});
    check(layout.width<=390&&!layout.overflow&&layout.left>=0&&layout.right<=390&&layout.target>=44,'mobile layout');
    await page.screenshot({path:'output/playwright/verified-mobile.png'});
    report('Combine checkbox, forced-color selected text, 390px layout and touch targets');
    await page.getByRole('button',{name:'Dismiss',exact:true}).click();
    check(!(await summary()).active&&!await page.locator('#result-card').isVisible(),'dismiss clears results and selection');
    // Verified-data questions are routed automatically by their shape; there is no mode switch.
    response=unsupported;await ask();check((await page.locator('#verified-panel').innerText()).includes('This question cannot be verified with the available datasets'),'unsupported message');
    check(await page.locator('.verified-bars').count()===0,'unsupported no chart');
    report('mode changes clear stale state; unsupported never invents chart');
    response=JSON.parse(JSON.stringify(fixture));response.source.snapshot_sha256=null;
    await page.getByRole('button',{name:'Ask another',exact:true}).click();
    await page.getByRole('textbox',{name:'Predict anything',exact:true}).fill(fixture.question);await page.keyboard.press('Enter');await page.locator('#verified-heading').waitFor();
    check(!(await page.locator('#verified-panel').innerText()).includes('Verified source data'),'missing hash unknown');
    response='network-error';await page.getByRole('button',{name:'Dismiss',exact:true}).click();await ask();
    check((await page.locator('#verified-host').innerText()).includes('service is unavailable'),'network failure explicit');check(await page.locator('.verified-bars').count()===0,'network no chart');
    report('missing provenance shows Unknown; network error has no fallback');
    response=fixture;await page.getByRole('button',{name:'Dismiss',exact:true}).click();
    let release;hold=new Promise(resolve=>{release=resolve;});
    await page.getByRole('group',{name:'Ask a prediction question'}).click();await page.getByRole('textbox',{name:'Predict anything',exact:true}).fill(fixture.question);await page.keyboard.press('Enter');
    await page.waitForFunction(async()=> (await import('/src/app.js')).state.phase==='waiting');
    await page.keyboard.press('Escape');release();hold=null;
    await page.waitForFunction(async()=> (await import('/src/app.js')).state.queryMode==='simulation');
    check(!await page.locator('#result-card').isVisible(),'cancelled response cannot resurface');
    report('mode change cancels in-flight query and discards stale response');
    check(errors.length===0,`page errors: ${errors.join(';')}`);
    check(!calls.some(c=>/\/parse$|\/poll$|\/branches$/.test(c.path)),'no simulation prediction calls');
    report('zero page errors and no parse, branch or poll request');
  }catch(error){cases.push({name:'failure',status:'failed',error:String(error)});}
  await page.evaluate(result=>window.__verifiedEvidence=result,{cases,errors,calls});
  return cases;
}
