import { handle } from '../lib/http.js';
import { draftingBillSweep } from '../lib/desk-drafting-bill.js';

export default handle(['POST'], draftingBillSweep);
