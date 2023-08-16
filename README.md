# twymlapze

Download wyze video events to disk

# Usage:

Ensure you have a `.config.json` file with your wyze creds in this folder, eg:

```
{
    "username": "example@email.com",
    "password": "abcdefgh"
    "xApiKey": "your xApiKey" (optional, see https://developer-api-console.wyze.com/#/apikey/view)
}
```

`node index "camera name" [folder for videos]`

eg: 
```
npm i
node index.js 'My Cam' ./dir-to-save-videos
```