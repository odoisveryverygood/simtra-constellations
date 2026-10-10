// Run with playwright-cli run-code --filename frontend/tests/browser-smoke.js.
// Uses actual DOM input and canvas draw commands; no live backend/model requests.
async (page) => {
  page.setDefaultTimeout(8000);
  const cases = [], errors = [], external = [];
  const check = (condition, message, evidence) => { if (!condition) throw new Error(`${message}: ${JSON.stringify(evidence)}`); };
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
  await page.unrouteAll({behavior:'ignoreErrors'});
  await page.route('**/*', route => {
    if (!route.request().url().startsWith('http://localhost:5173/')) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const report = async (name, evidence = {}) => { cases.push({name,status:'passed',...evidence}); await page.evaluate(result=>{window.__smokeEvidence=result;},{cases,errors,external}); };
  const summary = () => page.evaluate(async () => {
    const {map} = await import('/src/app.js');
    const el = document.querySelector('[data-evidence-summary]');
    return {...map.getSegmentSelectionSummary(),text:el?.textContent,domRaw:Number(el?.dataset.rawCount),domWeight:Number(el?.dataset.weightedCount)};
  });
  async function ask(question) {
    await page.getByRole('group',{name:'Ask a prediction question'}).click();
    await page.getByRole('textbox',{name:'Predict anything'}).fill(question);
    await page.keyboard.press('Enter');
    await page.getByRole('dialog',{name:'Prediction result'}).waitFor({state:'visible',timeout:15000});
  }
  async function openChart() { if (!(await page.locator('#evidence-details').getAttribute('open'))) {
    if (!await page.locator('#evidence-details').evaluate(el=>el.open)) await page.getByText('Explore demographic evidence',{exact:true}).click();
  } }
  async function choose(dimension,key,options={}) {
    await page.locator('#evidence-dimension').selectOption(dimension);
    await page.locator(`#evidence-host button[data-dimension="${dimension}"][data-key="${key}"]`).click(options);
  }
  try {
    await page.setViewportSize({width:1440,height:1000});
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.goto('http://localhost:5173/?demo=1');
    await page.waitForFunction(async()=> (await import('/src/app.js')).state.phase==='idle');
    check(errors.length===0,'boot console errors',errors); await report('a. app boot without console errors');
    await ask('Should the city expand public transit?');
    const result = await page.evaluate(async()=>{ const {map,state}=await import('/src/app.js'); return {mode:map.mode,verdicts:map.agents.filter(a=>a.verdict).length,n:state.rawResidents.length,fixture:state.lastResult.fixture_mode}; });
    check(result.mode==='results' && result.verdicts===256 && result.fixture,'fixture prediction and reveal',result);
    await report('b. deterministic local binary result and resident reveal',result);
    await openChart(); await report('c. open demographic chart');
    await choose('gender','women');
    let selected=await summary();
    check(selected.active && selected.rawMatchingAgents===117 && selected.weightedPumsCount===10750,'Women exact totals',selected);
    check(selected.domRaw===117 && selected.domWeight===10750,'DOM exact totals',selected);
    await report('d/f. Women bar selects 117 residents and 10750 PWGTP',selected);
    // Wrap the real canvas context for one synchronous frame and restore it.
    // Map camera is fitted using the normal Return action before recording.
    await page.emulateMedia({reducedMotion:'reduce'});
    if (await page.getByRole('button',{name:'Return to the whole city'}).isVisible()) await page.getByRole('button',{name:'Return to the whole city'}).click();
    const drawing = await page.evaluate(async()=>{
      const {map}=await import('/src/app.js');
      map._draw(performance.now());
      const c=map.ctx, calls=[], originals={};
      for(const method of ['drawImage','fillRect','strokeRect']) { originals[method]=c[method]; c[method]=function(...args){calls.push({method,alpha:this.globalAlpha,stroke:this.strokeStyle});return originals[method].apply(this,args);}; }
      try { map._drawSprites(performance.now(),0); } finally { for(const [key,value] of Object.entries(originals)) c[key]=value; }
      const bodies=calls.filter(c=>c.method==='drawImage'||c.method==='fillRect');
      return {green:calls.filter(c=>c.method==='strokeRect' && c.stroke==='#22c55e').length,dim:bodies.filter(c=>c.alpha<.5).length,full:bodies.filter(c=>c.alpha>=.5).length,bodyCount:bodies.length};
    });
    check(drawing.green===117 && drawing.dim===139 && drawing.full===117 && drawing.bodyCount===256,'canvas highlight and dim commands',drawing);
    await report('e. canvas: all matches green, nonmatches dim',drawing);
    await page.getByRole('button',{name:'Clear selection',exact:true}).click();
    selected=await summary(); check(!selected.active && selected.rawMatchingAgents===256 && selected.weightedPumsCount===25388,'Clear restores full population',selected);
    await report('g. Clear',selected);
    await choose('gender','women'); await choose('age','25-34',{modifiers:['Shift']});
    const combined=await summary();
    const independent=await page.evaluate(async()=>{const {state}=await import('/src/app.js');const rows=state.rawResidents.filter(a=>a.segments.gender==='women'||a.segments.age==='25-34');return {count:rows.length,weight:rows.reduce((s,a)=>s+a.pums_weight,0)};});
    check(combined.rawMatchingAgents===independent.count && combined.weightedPumsCount===independent.weight && combined.text.includes('age = 25-34 OR gender = women'),'combined OR totals',{combined,independent});
    await report('h. Shift-click union deduplicates weighted residents',{combined,independent});
    await page.getByRole('button',{name:'Clear selection',exact:true}).click();
    await page.locator('#evidence-combine').check();
    await choose('gender','women'); await choose('age','25-34');
    check((await summary()).weightedPumsCount===independent.weight,'touch combine control'); await report('touch-accessible Combine control');
    await page.locator('#evidence-combine').uncheck();
    // Click a visible map resident, taking geometry from the same drawn map.
    const tap=await page.evaluate(async()=>{const {map}=await import('/src/app.js');const a=map.agents.find(a=>{const p=map.worldToScreen(a.wx,a.wy);return p.x>50&&p.x<innerWidth-50&&p.y>160&&p.y<350&&document.elementFromPoint(p.x,p.y-3)?.id==='map';}); if(!a) throw Error('No visible resident');const p=map.worldToScreen(a.wx,a.wy);const hit=map._hitSprite(p.x,p.y-3,true);return {x:p.x,y:p.y-3,id:hit.seed,key:hit.segments.age};});
    await page.mouse.click(tap.x,tap.y);
    selected=await summary();
    check(selected.text.includes(`age = ${tap.key}`) && selected.text.includes(`Resident ${tap.id} selected`),'resident updates active age dimension',{selected,tap});
    check(await page.locator(`button[data-dimension="age"][data-key="${tap.key}"]`).evaluate(el=>el===document.activeElement),'resident focuses active segment');
    await report('i. actual map resident click updates/focuses active Age chart',{tap,selected});
    await page.keyboard.press('Escape');
    check(!(await summary()).active && await page.locator('#result-card').isVisible(),'Escape clears without dismissing result');
    const age=page.locator('button[data-dimension="age"][data-key="25-34"]');
    await age.focus(); await page.keyboard.press('Enter');check((await summary()).active,'Enter activates');
    await page.keyboard.press('Escape');await age.focus();await page.keyboard.press('Space');check((await summary()).active,'Space activates');
    await page.keyboard.press('ArrowDown');check(await page.evaluate(()=>document.activeElement.dataset.key==='35-44'),'arrow navigation');
    await report('j. keyboard Enter, Space, arrows and Escape');
    const focus=await page.evaluate(()=>({width:getComputedStyle(document.activeElement).outlineWidth,style:getComputedStyle(document.activeElement).outlineStyle,label:document.activeElement.getAttribute('aria-label')}));
    check(parseFloat(focus.width)>=2 && focus.style!=='none' && focus.label,'visible focus and label',focus);
    await report('visible focus and screen-reader labels',focus);
    await page.locator('#evidence-dimension').selectOption('education');await page.locator('button[data-dimension="education"]').first().click();
    check((await summary()).rawMatchingAgents>0,'expanded canonical map dimension');await report('Education dimension integration');
    await page.getByText('Explore demographic evidence',{exact:true}).click();
    await page.waitForFunction(async()=>!(await import('/src/app.js')).map.getSegmentSelectionSummary().active);
    await report('closing chart clears selection');
    await openChart(); await choose('gender','women');
    await page.getByRole('button',{name:'Dismiss',exact:true}).click(); check(!(await summary()).active,'dismiss resets map');await report('dismiss clears selection');
    await ask('Should the city expand public transit?');await openChart();await choose('gender','women');
    await page.getByRole('button',{name:'Ask another',exact:true}).click();check(!(await summary()).active,'new question clears');await report('starting another question clears selection');
    await page.getByRole('textbox',{name:'Predict anything'}).fill('Which proposal should the city prioritize?');await page.keyboard.press('Enter');await page.locator('#result-card').waitFor({state:'visible'});
    check(await page.locator('.res-opt').count()===3,'three option result');await openChart();await choose('gender','women');
    check((await page.locator('button[data-key="women"]').innerText()).includes('Parks: 50.0%'),'options chart uses real distribution');await report('multi-option result and chart');
    await page.getByRole('button',{name:'Switch city'}).click();
    await page.getByRole('option',{name:'New York City',exact:false}).click();
    await page.waitForFunction(async()=>{const {state}=await import('/src/app.js');return state.city.slug==='neu_york'&&!state.switching;});
    check(!(await summary()).active && !await page.locator('#result-card').isVisible(),'city reset');await report('switch city clears stale state');
    await ask('Should the city expand public transit?');await openChart();await choose('gender','women');
    await page.evaluate(async()=>{const {state}=await import('/src/app.js');const api=await import('/src/api.js');await api.deleteBranch(state.branchId);});
    check(!(await summary()).active && await page.locator('#evidence-panel').count()===0,'deleting branch clears chart');await report('deleting prediction branch clears selection');
    await page.getByRole('button',{name:'Dismiss',exact:true}).click();
    // A/B is a mode of the one composer: open it, pick A/B, fill the question and variants, send.
    await page.getByRole('group',{name:'Ask a prediction question'}).click();
    await page.getByRole('radio',{name:'A/B',exact:true}).click();
    await page.getByLabel('Evaluation question',{exact:true}).fill('Which transit message is clearer?');
    await page.getByLabel('Variant A',{exact:true}).fill('More frequent buses.');await page.getByLabel('Variant B',{exact:true}).fill('Shorter commutes.');
    await page.getByRole('button',{name:'Send',exact:true}).click();await page.locator('#result-card').waitFor({state:'visible'});
    check(await page.locator('.ab-headline').isVisible(),'A/B result');await openChart();await choose('gender','women');
    check((await page.locator('button[data-key="women"]').innerText()).includes('Variant A: 60.0%'),'A/B chart shares');await report('A/B result and chart');
    await page.getByRole('button',{name:'Dismiss',exact:true}).click();
    // the post test is the third composer mode
    await page.getByRole('group',{name:'Ask a prediction question'}).click();
    await page.getByRole('radio',{name:'Post test',exact:true}).click();
    await page.getByLabel('Target question',{exact:true}).fill('Should the city expand public transit?');await page.locator('#marketing-copy').fill('More frequent buses for every neighborhood.');
    await page.getByRole('button',{name:'Send',exact:true}).click();await page.locator('#result-card').waitFor({state:'visible',timeout:15000});
    check(await page.locator('.res-cf-grid').isVisible(),'counterfactual result');await openChart();await choose('gender','women');check((await summary()).active,'exposed chart selection');await report('counterfactual result and exposed-arm chart');
    const positions=await page.evaluate(async()=>{const {map}=await import('/src/app.js');const before=map.agents.map(a=>[a.wx,a.wy,a.frameClock]);map._draw(performance.now()+5000);return {reduced:map.reducedMotion,frozen:JSON.stringify(before)===JSON.stringify(map.agents.map(a=>[a.wx,a.wy,a.frameClock]))};});
    check(positions.reduced && positions.frozen,'reduced motion map frozen',positions);await report('reduced-motion map and reveal',positions);
    await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
    const forced=await page.locator('button[data-key="women"]').evaluate(el=>({border:getComputedStyle(el).borderTopWidth,pressed:el.getAttribute('aria-pressed'),text:el.firstElementChild.textContent}));
    check(forced.pressed==='true'&&forced.text.includes('✓')&&parseFloat(forced.border)>=3,'forced-colors selected state',forced);await report('forced-colors selection is not color-only',forced);
    await page.emulateMedia({forcedColors:'none',reducedMotion:'reduce'});
    await page.setViewportSize({width:390,height:844});
    await page.locator('button[data-key="women"]').scrollIntoViewIfNeeded();
    const mobile=await page.evaluate(()=>{const card=document.querySelector('#result-card'),b=document.querySelector('button[data-key="women"]'),r=b.getBoundingClientRect(),c=card.getBoundingClientRect();return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,cardLeft:c.left,cardRight:c.right,cardHeight:c.height,buttonWidth:r.width,buttonHeight:r.height,clientWidth:card.clientWidth,scrollWidth:card.scrollWidth};});
    check(mobile.documentWidth<=390 && mobile.cardLeft>=0 && mobile.cardRight<=390 && mobile.scrollWidth<=mobile.clientWidth && mobile.buttonHeight>=44 && mobile.cardHeight<=844*.55,'mobile layout and touch targets',mobile);
    await page.getByRole('button',{name:'Clear selection',exact:true}).click();check(!(await summary()).active,'mobile Clear');await report('k. 390px mobile layout, targets and Clear',mobile);
    check(errors.length===0,'console/page errors',errors);check(external.length===0,'rendering attempted an external request',external);
    await report('no console errors or external network requests',{errors,external});
  } catch (error) { cases.push({name:'failure',status:'failed',error:String(error)}); }
  await page.evaluate(result=>{window.__smokeEvidence=result;},{cases,errors,external});
  return cases;
}
