import { Browser, ElementHandle, Page } from "puppeteer";
import dotenv from 'dotenv';
import csvtojson from 'csvtojson';
import { MongoClient } from 'mongodb';
import * as json2csv from 'json2csv';
import * as fs from 'fs';

const puppeteerExtra = require('puppeteer-extra');
const pluginStealth = require('puppeteer-extra-plugin-stealth');
const RecaptchaPlugin = require('puppeteer-extra-plugin-recaptcha');

dotenv.config();

(async () => {
    const dbUrl = `mongodb://${process.env.cobaltIntelligenceDbUser}:${process.env.cobaltIntelligenceDbPass}@${process.env.cobaltIntelligenceDbUrl}/${process.env.cobaltIntelligenceDb}`;
    const dbClient = new MongoClient(dbUrl, {
        useNewUrlParser: true,
        useUnifiedTopology: true
    });

    await dbClient.connect();
    const collection = 'deSosBusinesses';    
    const businesses = await dbClient.db().collection(collection).find({}, {projection: {_id: 0}}).toArray();
    

    const csv = json2csv.parse(businesses);

    fs.writeFileSync('Delaware businesses.csv', csv);
    // const businesses = await dbClient.db().collection(collection).find({ sosId: { $exists: false } }).toArray();

    // console.log('Business length', businesses.length);

    // const chunkedBusinesses = chunk(businesses, 10);

    // const promises: any[] = [];
    
    // for (let i = 0; i < chunkedBusinesses.length; i++) {
    //     const chunkedBusiness = chunkedBusinesses[i];
    
    //     promises.push(getBusinessData(chunkedBusiness, dbClient, collection));
        
    // }

    // await Promise.all(promises);
    
    await dbClient.close();

})();

async function getBusinessData(businesses: any[], dbClient: MongoClient, collection: string) {
    puppeteerExtra.use(
        RecaptchaPlugin({
            provider: { id: '2captcha', token: process.env.captchaToken },
            visualFeedback: true // colorize reCAPTCHAs (violet = detected, green = solved)
        })
    );
    puppeteerExtra.use(pluginStealth());
    const browser = await puppeteerExtra.launch({ headless: true });

    for (let i = 0; i < businesses.length; i++) {
        const business = businesses[i];

        const searchQuery = business.legalBusinessName;

        console.log('Searching for', searchQuery);

        try {
            const businessResponse: any = await searchBusinesses(searchQuery, browser);

            if (businessResponse.length !== 0) {
                console.log('Response for Delaware', businessResponse);

                business.sosId = businessResponse.sosId;
                business.filingDate = businessResponse.filingDate;
                business.stateOfSosRegistration = businessResponse.stateOfSosRegistration;
                business.entityType = businessResponse.entityType;
                business.agentName = businessResponse.agentName;
                business.agentStreetAddress = businessResponse.agentStreetAddress;
                business.agentCity = businessResponse.agentCity;
                business.agentState = businessResponse.agentState;
                business.agentZip = businessResponse.agentZip;
                business.phoneNumber = businessResponse.phoneNumber;

                await dbClient.db().collection(collection).replaceOne({ _id: business._id }, business);

            }

            // Alternative businesses
            else {
                console.log('Only alternative businesses found for Delaware', businessResponse);
                console.log('End in else', {
                    message: `No business found with exact name of ${searchQuery}. Did you mean one of the alternative businesses?`,
                    alternativeBusinesses: businessResponse
                });

                business.sosId = 'No business found';
                await dbClient.db().collection(collection).replaceOne({ _id: business._id }, business);
            }
        }
        catch (e) {
            console.log('Error getting business details', e);

            // console.timeEnd('Start');
            console.log('End in catch', { message: 'No business found.' });
        }
    }
    await browser.close();
}

async function searchBusinesses(businessName: string, browser: Browser) {
    const url = 'https://icis.corp.delaware.gov/ecorp/entitysearch/namesearch.aspx';

    const page = await browser.newPage();

    await page.goto(url);

    // This will throw and bubble up if we don't find anything
    await handleSearchAndCaptcha(page, businessName);

    console.log('Passed searchAndCaptcha, now we get the business details');

    const tableRows = await page.$$('#tblResults tr');

    const alternativeBusinessesNames: string[] = [];

    // Start at 1 because the first one is the header row
    for (let i = 1; i < tableRows.length; i++) {
        const tableRow = tableRows[i];

        const titleToTest = await tableRow.$eval('a', element => element.textContent);

        if (formatBusinessName(titleToTest) === formatBusinessName(businessName)) {
            // get business details because we found it!
            const link = await tableRow.$('a');
            await link.click();

            // Sometimes it just redirects to the home page again because...just because?
            try {
                await page.waitForSelector('#ctl00_ContentPlaceHolder1_lblFileNumber', { timeout: 20000 });
            }
            catch (e) {
                console.log('Redirecting again to home for some reason.');
                await page.close();
                return await searchBusinesses(businessName, browser);
            }

            const businessDetails: IBusiness = await getBusinessDetails(page);
            await page.close();

            return businessDetails;
        }
        else {
            alternativeBusinessesNames.push(titleToTest);
        }
    }
    await page.close();

    return alternativeBusinessesNames;
}

async function getBusinessDetails(page: Page): Promise<IBusiness> {
    // We cannot get the page url here
    // Url looks like this: https://icis.corp.delaware.gov/eCorp/EntitySearch/NameSearch.aspx
    const businessDetails: IBusiness = {
        sosId: await page.$eval('#ctl00_ContentPlaceHolder1_lblFileNumber', element => element.textContent),
        filingDate: await page.$eval('#ctl00_ContentPlaceHolder1_lblIncDate', element => element.textContent),
        title: await page.$eval('#ctl00_ContentPlaceHolder1_lblEntityName', element => element.textContent),
        entityType: await page.$eval('#ctl00_ContentPlaceHolder1_lblEntityKind', element => element.textContent),
        stateOfSosRegistration: await page.$eval('#ctl00_ContentPlaceHolder1_lblState', element => element.textContent),
        agentName: await page.$eval('#ctl00_ContentPlaceHolder1_lblAgentName', element => element.textContent),
        agentStreetAddress: await page.$eval('#ctl00_ContentPlaceHolder1_lblAgentAddress1', element => element.textContent),
        agentCity: await page.$eval('#ctl00_ContentPlaceHolder1_lblAgentCity', element => element.textContent),
        agentState: await page.$eval('#ctl00_ContentPlaceHolder1_lblAgentState', element => element.textContent),
        agentZip: await page.$eval('#ctl00_ContentPlaceHolder1_lblAgentState', element => element.textContent),
        phoneNumber: await page.$eval('#ctl00_ContentPlaceHolder1_lblAgentPhone', element => element.textContent),
    };

    return businessDetails;
}

async function handleSearchAndCaptcha(page: Page, businessName: string, captchaSolved = false) {
    await page.waitForSelector('#ctl00_ContentPlaceHolder1_frmEntityName', { timeout: 3000 });
    await page.type('#ctl00_ContentPlaceHolder1_frmEntityName', businessName);
    await page.click('[type="submit"]');

    let captcha: ElementHandle;

    try {
        await page.waitForSelector('.g-recaptcha', { timeout: 1000 });
        captcha = await page.$('.g-recaptcha');
    }
    catch (e) {
        console.log('No captcha here.');
        captchaSolved = true;
    }

    // We are calling this after we solved the captcha
    // Or no captcha is visible
    if (captchaSolved) {
        try {
            await page.waitForSelector('#tblResults tr', { timeout: 20000 });
        }
        catch (e) {
            throw e;
        }
        const tableRows = await page.$$('#tblResults tr');

        // The first row is the header row
        if (tableRows.length > 1) {
            // We got results!
            console.log('Found some results. You are the best ever.');
            return;
        }
    }

    // Three paths:
    // 1. Found results - '#tblResults tr:nth-of-type(2)' will exist
    // 2. Can't find results - 'No Records Found.' '#ctl00_ContentPlaceHolder1_divCountsMsg' with some content    
    // 3. Captcha displayed    

    if (captcha) {
        console.log('We hit the captcha. It is solvin time');
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (<any>page).solveRecaptchas();
            console.log('After solving recaptcha');
            await page.click('[type="submit"]');

            return await handleSearchAndCaptcha(page, businessName, true);
        } catch (e) {
            console.log('Error happened when trying to solve captcha.');
            throw e;
        }
    }
}

function formatBusinessName(businessName: string) {
    if (businessName) {
        return businessName.replace(/,/g, '').replace(/\./g, '').replace(/‎/g, '').toLocaleLowerCase().trim();
    }
    else {
        return null;
    }
}

function chunk(arr: any[], chunkSize: number) {
    if (chunkSize <= 0) {
        throw 'Invalid chunk size';
    }
    const chunkedArrays = [];
    for (let i = 0; i < arr.length; i += chunkSize) {
        chunkedArrays.push(arr.slice(i, i + chunkSize));
    }

    return chunkedArrays;
}

interface IBusiness {
    title?: string;
    filingDate?: string;
    stateOfFormation?: string;
    stateOfSosRegistration?: string;
    status?: string;
    agentName?: string;
    agentCity?: string;
    agentState?: string;
    agentZip?: string;
    agentStreetAddress?: string;
    physicalAddress?: string;
    physicalAddressStreet?: string;
    physicalAddressCity?: string;
    physicalAddressState?: string;
    physicalAddressZip?: string;
    mailingAddressStreet?: string;
    mailingAddressCity?: string;
    mailingAddressState?: string;
    mailingAddressZip?: string;
    entityType?: string;
    phoneNumber?: string;
    email?: string;
    agentIsCommercial?: boolean;
    url?: string;
    industry?: string;
    sosId?: string;
};