// Compatibility for integrations using the previous Check Plus module.
const checkPlan = require('./checkPlan');

module.exports = {
  ...checkPlan,
  checkPlusOne: checkPlan.checkPlanOne,
  checkPlusBatch: checkPlan.checkPlanBatch
};
