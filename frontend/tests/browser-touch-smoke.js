async (page) => {
  const context=await page.context().browser().newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const mobile=await context.newPage(); mobile.setDefaultTimeout(8000);
  const errors=[],external=[];
  mobile.on('pageerror',e=>errors.push(String(e)));
  mobile.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await mobile.route('**/*',route=>{if(!route.request().url().startsWith('http://localhost:5173/')) {external.push(route.request().url());return route.abort();}return route.continue();});
  const cases=[];
  const check=(value,message)=>{if(!value)throw Error(message);};
  try {
    await mobile.goto('http://localhost:5173/?demo=1');
    await mobile.waitForFunction(async()=> (await import('/src/app.js')).state.phase==='idle');
    await mobile.getByRole('group',{name:'Ask a prediction question'}).tap();
    await mobile.getByRole('textbox',{name:'Predict anything'}).fill('Should the city expand public transit?');
    await mobile.keyboard.press('Enter');
    await mobile.locator('#result-card').waitFor({state:'visible'});
    await mobile.getByText('Explore demographic evidence',{exact:true}).tap();
    await mobile.locator('button[data-key="women"]').tap();
    const get=()=>mobile.evaluate(async()=> (await import('/src/app.js')).map.getSegmentSelectionSummary());
    let result=await get();check(result.rawMatchingAgents===117 && result.weightedPumsCount===10750,'Touch Women totals');
    cases.push({name:'actual touchscreen Women bar',status:'passed',...result});
    await mobile.locator('#evidence-combine').tap();
    await mobile.locator('#evidence-dimension').selectOption('age');
    await mobile.locator('button[data-dimension="age"][data-key="25-34"]').tap();
    result=await get();check(result.rawMatchingAgents===148&&result.weightedPumsCount===14620,'Touch union totals');
    cases.push({name:'actual touchscreen combined filter',status:'passed',...result});
    await mobile.getByRole('button',{name:'Clear selection',exact:true}).tap();
    check(!(await get()).active,'Touch Clear');cases.push({name:'actual touchscreen Clear',status:'passed'});
    await mobile.locator('#evidence-resident').selectOption('1');
    check((await get()).active,'accessible resident picker');cases.push({name:'accessible resident picker uses active age dimension',status:'passed'});
    await mobile.locator('#evidence-dimension').selectOption('gender');await mobile.locator('button[data-key="women"]').tap();
    await mobile.screenshot({path:'/tmp/simtra-integration-evidence/mobile.png'});
    await mobile.evaluate(async()=>{const {state,map}=await import('/src/app.js');for(const resident of state.rawResidents){delete resident.pums_weight;delete resident.segments;}map.setAgents(state.rawResidents);});
    await mobile.locator('#evidence-dimension').selectOption('gender_x_age');
    check((await mobile.locator('[data-evidence-summary]').innerText()).includes('Counts are unknown'),'missing legacy metadata must not become zero');
    check(await mobile.locator('button[data-dimension="gender_x_age"]').first().isDisabled(),'legacy matching must be disabled');
    cases.push({name:'legacy resident records degrade to unknown counts without cross-tab errors',status:'passed'});
    check(errors.length===0&&external.length===0,'Touch console/network errors');
  } catch(error) {cases.push({name:'touch failure',status:'failed',error:String(error)});}
  await page.evaluate(result=>{window.__touchEvidence=result;},{cases,errors,external});
  await context.close();
  return cases;
}
