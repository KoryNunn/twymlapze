const process = require('process');

const folder = process.argv[3] || process.cwd();
const deviceName = process.argv[2];

if(!deviceName) {
  console.log('Usage: `node index "camera name" [folder for videos]`');
  process.exit();
}

try {
  require('./.config')
} catch(error) {
  console.log('Ensure you have a `.config.json` file with your wyze creds in this folder. Check the README.md for an example');
  process.exit();
}

const config = require('./.config');

const Wyze = require('wyze-node');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const concurrencyLimit = require('concurrun');
const { utimes } = require('utimes');
const format = require('date-fns/format');
const formatTimestamp = require('./formatTimestamp');
const glob = require('fast-glob');

const wyze = new Wyze(config);
const defaultOutputDir = `${__dirname}/videos`
const limmitDownloadConcurrency = concurrencyLimit(2).promise;

function createFileName(startTime, endTime) {
  return `${formatTimestamp(startTime)}.mkv`;
}

async function getS3VideoDownloadPath(outputDir, event, deviceName, s3Resource) {
  const outFileDir = `${outputDir || defaultOutputDir}/${deviceName}`;
  const fileName = createFileName(event.event_ts, event_ts + (s3Resource?.file_params?.video_length * 1000 || Date.now() - event.event_ts));
  const outFilePath = `${outFileDir}/${fileName}`;

  return { fileName, outFilePath }
}

async function getKVSVideoDownloadPath(outputDir, event, deviceName, kvsResource) {
  const outFileDir = `${outputDir || defaultOutputDir}/${deviceName}`;
  const fileName = createFileName(kvsResource.begin_time, kvsResource.end_time);
  const outFilePath = `${outFileDir}/${fileName}`;

  return { fileName, outFilePath }
}

async function getEventDownloadInfo(outputDir, event, deviceName) {
    const s3Resource = event.event_resources.find(resource => (resource.type == 2) && resource.resource_type === 's3');
    const kvsResource = event.event_resources.find(resource => resource.resource_type === 'kvs' && resource.end_time); // kvs resources without an end time are still recording
    
    let fileName;
    let outFilePath;

    if (s3Resource && s3Resource.file_params?.video_length) {
      const { fileName: s3FileName, outFilePath: s3OutFilePath } = await getS3VideoDownloadPath(outputDir, event, deviceName, s3Resource);
      fileName = s3FileName;
      outFilePath = s3OutFilePath;
    } else if (kvsResource && kvsResource.end_time - kvsResource.begin_time) {
      const { fileName: kvsFileName, outFilePath: kvsOutFilePath } = await getKVSVideoDownloadPath(outputDir, event, deviceName, kvsResource);
      fileName = kvsFileName;
      outFilePath = kvsOutFilePath;
    } else {
      return;
    }

    if(fs.existsSync(outFilePath)) {
      return;
    }

    return {
      fileName,
      path: outFilePath,
      download: s3Resource ? limmitDownloadConcurrency(() => downloadS3Video(outFilePath, event, s3Resource)) : limmitDownloadConcurrency(() => downloadKVSVideo(outFilePath, event, kvsResource))
    };
}

async function setFileTimestamps(filePath, timestamp) {
  await utimes(filePath, { btime: timestamp, mtime: timestamp });
}

async function downloadS3Video(outFilePath, event, s3Resource) {
  await mkdirp(path.dirname(outFilePath));

  await new Promise((resolve, reject) => {
    ffmpeg(s3Resource.url)
      .output(outFilePath)
      .outputOptions('-metadata', `taken_at="${event.event_ts}"`)
      .on('end', function() {
        resolve(outFilePath);
      })
      .on('error', reject)
      .run();
  });

  await setFileTimestamps(outFilePath, event.event_ts);

  return outFilePath;
}

async function downloadKVSVideo(outFilePath, event, kvsResource) {
  await mkdirp(path.dirname(outFilePath));

  const video = await wyze.getEventVideoURL({
    deviceMac: event.device_mac,
    deviceModel: event.device_model,
    beginTime: kvsResource.begin_time,
    endTime: kvsResource.end_time
  });

  await new Promise((resolve, reject) => {
    ffmpeg(video.data.play_url)
      .output(outFilePath)
      .outputOptions('-metadata', `taken_at="${kvsResource.begin_time}"`)
      .on('end', function() {
        resolve(outFilePath);
      })
      .on('error', reject)
      .run();
  });

  await setFileTimestamps(outFilePath, kvsResource.begin_time);

  return outFilePath;
}

async function getFullEventList (device, beginTime, endTime, limit, currentList = []) {
  if (limit - currentList.length <= 0) {
    return currentList;
  }

  const eventsBatch = (await wyze.getEventList({
    count: 30,
    deviceMacList: [device.mac],
    beginTime: beginTime && String(beginTime),
    endTime: endTime && String(endTime),
  })).data.event_list;

  const eventList = currentList.concat(eventsBatch.sort((a, b) => b.event_ts - a.event_ts));

  if (eventList.length) {
    console.log(`Found ${eventList.length} events between ${formatTimestamp(eventList[0]?.event_ts)} and ${formatTimestamp(eventList[eventList.length - 1]?.event_ts)}`);
  }

  if (eventsBatch.length === 30 && beginTime && endTime) {
    return getFullEventList(device, beginTime, eventList[eventList.length - 1].event_ts, limit, eventList);
  }

  return eventList;
}

async function run(outputDir, deviceName, options = {}) {
  const { beginTime = null, endTime = Date.now(), limit = Infinity } = options;
  const device = await wyze.getDeviceByName(deviceName);

  console.log(`Getting${limit != Infinity ? ` up to ${limit}` : ''} events${beginTime ? ` from ${formatTimestamp(beginTime)}` : ''} ${endTime ? ` up until ${formatTimestamp(endTime)}` : ''}`);

  const eventList = await getFullEventList(device, beginTime, endTime, limit);

  console.log(`Processing ${eventList.length} events`);

  const eventDownloadInfos = await eventList.reduce(async (remainingPromise, event) => {
    const [remaining, eventDownloadInfo] = await Promise.all([
      remainingPromise,
      getEventDownloadInfo(outputDir, event, deviceName)
    ]);

    if (eventDownloadInfo) {
      return remaining.concat(eventDownloadInfo);
    }

    return remaining;
  }, []);

  console.log(`Downloading ${eventDownloadInfos.length} events (${eventList.length - eventDownloadInfos.length} already downloaded)`);

  let complete = 0;

  await Promise.all(eventDownloadInfos.map(async eventDownloadInfo => 
    eventDownloadInfo.download()
      .then(() => {
        complete++;
        console.log(`Downloaded ${eventDownloadInfo.fileName} (${complete}/${eventDownloadInfos.length})`);
        return true;
      })
      .catch(error => {
        complete++;
        console.log(`${error.message} ${eventDownloadInfo.fileName} (${complete}/${eventDownloadInfos.length})`);
        return false;
      })
  ));
}

const matchDate = /^(\d{4})\-(0?[1-9]|1[012])\-(0?[1-9]|[12][0-9]|3[01]) ([01]?[0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])$/;
const filePaths = glob.sync([`${folder}/${deviceName}/*.mkv`]);

let latestDate = filePaths.map(filePath => {
  const match = path.basename(filePath.split('.')[0]).match(matchDate);

  if(!match) {
    return;
  }

  const [all, year, month, day, hour, minute, second] = match;

  const date = new Date();
  date.setFullYear(year);
  date.setMonth(month - 1);
  date.setDate(day);
  date.setHours(hour);
  date.setMinutes(minute);
  date.setSeconds(second);

  return date;
})
.filter(date => date && !isNaN(date))
.sort((a, b) => a - b)
.pop();

if (!latestDate) {
  console.log(`No existing downloads, getting the last 20 days worth`);
  latestDate = new Date();
  latestDate.setDate(latestDate.getDate() - 20);
}

run(folder, deviceName, {
  beginTime: latestDate.getTime()
}).then(console.log, console.log);

