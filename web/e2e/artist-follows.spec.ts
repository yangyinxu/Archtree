import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';

const id = '000000000000000000000065';
const viewer = 'e2e-follow-viewer';
const home = JSON.parse(readFileSync(new URL('../../test/fixtures/personalization/v1/listener-home.json', import.meta.url), 'utf8'));
const status = (following: boolean) => ({artistId:id, following, followedAt:following?'2026-10-12T15:00:00.000Z':null});
const session = { user: {id:viewer,email:'synthetic@example.test',displayName:'Lorem Listener',role:'user',avatarRevision:0,avatar:null,emailVerified:true,authenticationMethods:['password']} };
async function setup(page:Page, signedIn=true, failFirst=false) {
 let following=false, attempts=0;
 await page.route('**/api/listener/v1/capabilities',route=>route.fulfill({json:{playlists:false}}));
 await page.route('**/content/me/playlists?limit=50',route=>route.fulfill({json:{items:[],nextCursor:null},headers:{'X-Finitude-Account-Viewer':viewer}}));
 await page.route('**/auth/browser/session', route=>route.fulfill({status:signedIn?200:401,json:signedIn?session:{code:'unauthorized'}}));
 await page.route('**/api/listener/v1/personalization-capabilities',route=>route.fulfill({json:{contractVersion:1,deterministicDiscovery:false,artistFollows:true}}));
 await page.route(`**/api/listener/v1/artists/${id}`,route=>route.fulfill({json:{artist:{contentType:'artist',id,name:'Lorem Ensemble',bio:'Synthetic Artist',artworkUrl:''},albums:[],audioTracks:[]}}));
 await page.route('**/api/listener/v1/home',route=>{
   expect(route.request().headers()['x-finitude-personalization-version']).toBe('1');
   return route.fulfill({json:following?home:{title:'Home',sections:[]},headers:signedIn?{'X-Finitude-Account-Viewer':viewer}:{}});
 });
 await page.route('**/content/me/artist-follows/**',route=>{
   expect(route.request().headers()['x-finitude-account-viewer']).toBe(viewer);
   const headers={'X-Finitude-Account-Viewer':viewer};
   if(route.request().method()==='POST')return route.fulfill({json:{items:[status(following)]},headers});
   attempts++;
   if(failFirst&&attempts===1)return route.fulfill({status:503,json:{message:'Synthetic unavailable'},headers});
   following=route.request().method()==='PUT';return route.fulfill({json:status(following),headers});
 });
}

test('signed-out Follow shows an alert and keeps the Artist page',async({page})=>{
 await setup(page,false);await page.goto(`/finitude/artists/${id}`);
 await page.getByRole('button',{name:'Follow',exact:true}).click({force:true});
 await expect(page.getByRole('alert')).toContainText('Log in');
 await expect(page).toHaveURL(new RegExp(`/artists/${id}$`));
});

test('confirmed Follow, retry, new-release order and Artist explanation links',async({page})=>{
 await setup(page,true,true);await page.goto(`/finitude/artists/${id}`);
 await page.getByRole('button',{name:'Follow',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Could not update');
 await expect(page.getByRole('button',{name:'Follow',exact:true})).toHaveAttribute('aria-pressed','false');
 await page.getByRole('button',{name:'Retry update'}).click();
 await expect(page.getByRole('button',{name:'Following',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('link',{name:'Home',exact:true}).first().click();
 await expect(page.getByRole('heading',{name:'New from artists you follow'})).toBeVisible();
 const collection=page.locator('[data-presentation="carousel"]');
 await expect(collection.locator('article')).toHaveCount(4);
 await expect(collection.locator('article').first()).toContainText('Dolor Dawn');
 await expect(collection.locator('article').nth(1)).toContainText('Sit Sunset');
 await expect(collection.locator('article').nth(2)).toContainText('Amet Current');
 await expect(collection.locator('article').nth(3)).toContainText('Consectetur Rain');
 const reason=page.getByRole('link',{name:'New release from Lorem Ensemble',exact:true}).first();
 await expect(reason).toHaveAttribute('href',`/finitude/artists/${id}`);
 expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
 await page.screenshot({path:'/tmp/finitude-artist-follows-home.png',fullPage:true});
 await reason.click();
 await expect(page.getByRole('button',{name:'Following',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Following',exact:true}).click();
 await expect(page.getByRole('button',{name:'Follow',exact:true})).toHaveAttribute('aria-pressed','false');
 await page.getByRole('link',{name:'Home',exact:true}).first().click();
 await expect(page.getByRole('heading',{name:'New from artists you follow'})).toHaveCount(0);
});

test('explicit rollout disabled hides Follow without leaving the Artist page',async({page})=>{
 await setup(page);await page.route(`**/content/me/artist-follows/${id}`,route=>route.fulfill({
   status:503,json:{code:'ARTIST_FOLLOWS_DISABLED'},headers:{'X-Finitude-Account-Viewer':viewer}
 }));
 await page.goto(`/finitude/artists/${id}`);
 await page.getByRole('button',{name:'Follow',exact:true}).click();
 await expect(page.getByRole('button',{name:'Follow',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Retry update'})).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Lorem Ensemble'})).toBeVisible();
 await expect(page).toHaveURL(new RegExp(`/artists/${id}$`));
});

test('follow button supports narrow screens and Chinese localization',async({page})=>{
 await setup(page);await page.setViewportSize({width:390,height:844});
 await page.addInitScript(()=>localStorage.setItem('finitude.localization.preference.v1','zh-Hans'));
 await page.goto(`/finitude/artists/${id}`);
 // Exercise the deployed Chinese bundle and the same action at mobile width.
 const button=page.getByRole('button',{name:'关注',exact:true});
 await expect(button).toBeVisible();
 await button.click();await expect(page.getByRole('button',{name:'已关注',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
 await page.screenshot({path:'/tmp/finitude-artist-follows-mobile.png',fullPage:true});
});
