import loadDataFromAugurNode from 'modules/app/actions/load-data-from-augur-node';
import { updateHasLoadedMarketsToReportOn } from 'modules/reports/actions/update-has-loaded-reports';
import { updateMarketsData } from 'modules/markets/actions/update-markets-data';
import { updateMarketsWithAccountReportData } from 'modules/my-reports/actions/update-markets-with-account-report-data';
import logError from 'utils/log-error';

export const loadMarketsToReportOn = (options, callback = logError) => (dispatch, getState) => {
  const { branch, env, loginAccount } = getState();
  if (!loginAccount.address) return callback(null);
  if (!loginAccount.rep || loginAccount.rep === '0') return callback(null);
  if (!branch.id) return callback(null);
  const query = { ...options, branch: branch.id, reporter: loginAccount.address };
  loadDataFromAugurNode(env.augurNodeURL, 'getMarketsToReportOn', query, (err, marketsToReportOn) => {
    if (err) return callback(err);
    if (marketsToReportOn == null) {
      dispatch(updateHasLoadedMarketsToReportOn(false));
      return callback(`no markets-to-report-on data received from ${env.augurNodeURL}`);
    }
    // TODO
    // 1. *if* /getMarketsToReportOn returns market IDs only, we need to check if the market's
    //    data is already loaded (and call loadMarketsData if not)
    // 2. /getMarketsToReportOn should have 'rep earned' field, or look up separately
    dispatch(updateMarketsData(marketsToReportOn));
    dispatch(updateMarketsWithAccountReportData(marketsToReportOn));
    dispatch(updateHasLoadedMarketsToReportOn(true));
    callback(null, marketsToReportOn);
  });
};
