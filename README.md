# twymlapze

Download wyze video events to disk

# Usage:

Ensure you have a `.config.json` file with your wyze creds in this folder, eg:

```
{
    "username": "example@email.com",
    "password": "abcdefgh"
}
```

`node index "camera name" [folder for videos]`

eg: 
```
npm i
node index.js 'My Cam' ./dir-to-save-videos
```