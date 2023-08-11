const format = require('date-fns/format');

module.exports = function formatTimestamp(timestamp) {
    return format(timestamp, 'yyyy-MM-dd HH:mm:ss')
}