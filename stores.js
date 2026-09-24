export const stores = [
    { STORE_ID: '21633', API_KEY: process.env.STORE_21633, STORE_NAME: 'Amentum Inventory' },
    { STORE_ID: '40348', API_KEY: process.env.STORE_40348, STORE_NAME: 'Amentum Safety' },
    { STORE_ID: '12803', API_KEY: process.env.STORE_12803, STORE_NAME: 'ASE' },
    { STORE_ID: '9672', API_KEY: process.env.STORE_9672, STORE_NAME: 'Bon Appetit' },
    { STORE_ID: '47219', API_KEY: process.env.STORE_47219, STORE_NAME: 'Bon Appetit Nudge' },
    { STORE_ID: '8366', API_KEY: process.env.STORE_8366, STORE_NAME: 'BPA Store' },
    { STORE_ID: '16152', API_KEY: process.env.STORE_16152, STORE_NAME: 'Chartwells K12 Nudge' },
    { STORE_ID: '8466', API_KEY: process.env.STORE_8466, STORE_NAME: 'Compass Catalog' },
    { STORE_ID: '15521', API_KEY: process.env.STORE_15521, STORE_NAME: 'Cuilinart Nudge' },
    { STORE_ID: '24121', API_KEY: process.env.STORE_24121, STORE_NAME: 'EDTA Inventory' },
    { STORE_ID: '14077', API_KEY: process.env.STORE_14077, STORE_NAME: 'Eurest Hero' },
    { STORE_ID: '12339', API_KEY: process.env.STORE_12339, STORE_NAME: 'Eurest Nudge' },
    { STORE_ID: '43379', API_KEY: process.env.STORE_43379, STORE_NAME: 'FBLA' },
    { STORE_ID: '9369', API_KEY: process.env.STORE_9369, STORE_NAME: 'FCCLA' },
    { STORE_ID: '9805', API_KEY: process.env.STORE_9805, STORE_NAME: 'Flik' },
    { STORE_ID: '67865', API_KEY: process.env.STORE_67865, STORE_NAME: 'Flik PSR' },
    { STORE_ID: '48371', API_KEY: process.env.STORE_48371, STORE_NAME: 'Forbes Brand Store' },
    { STORE_ID: '48551', API_KEY: process.env.STORE_48551, STORE_NAME: 'Forbes Redemption' },
    { STORE_ID: '110641', API_KEY: process.env.STORE_110641, STORE_NAME: 'Keystone Redemption' },
    { STORE_ID: '41778', API_KEY: process.env.STORE_41778, STORE_NAME: 'Marriot Store' },
    { STORE_ID: '8267', API_KEY: process.env.STORE_8267, STORE_NAME: 'NRA Competitive Shooting' },
    { STORE_ID: '75092', API_KEY: process.env.STORE_75092, STORE_NAME: 'Phi Kappa Phi' },
    { STORE_ID: '8402', API_KEY: process.env.STORE_8402, STORE_NAME: 'Ryder FMS' },
    { STORE_ID: '68125', API_KEY: process.env.STORE_68125, STORE_NAME: 'Ryder SCS' },
    { STORE_ID: '8729', API_KEY: process.env.STORE_8729, STORE_NAME: 'SkillsUSA' },
    { STORE_ID: '47257', API_KEY: process.env.STORE_47257, STORE_NAME: 'Springs Living' },
    { STORE_ID: '8636', API_KEY: process.env.STORE_8636, STORE_NAME: 'TSA' },
    { STORE_ID: '118741', API_KEY: process.env.STORE_118741, STORE_NAME: 'Store AB' }
];

export const findStore = (storeId) => stores.find((store) => store.STORE_ID === String(storeId));

export const resolveStoreId = (shipment) => {
    if (shipment?.store_id !== undefined && shipment?.store_id !== null) {
        return String(shipment.store_id);
    }
    if (shipment?.source_id) {
        return String(shipment.source_id).split('-')[0];
    }
    return null;
};

