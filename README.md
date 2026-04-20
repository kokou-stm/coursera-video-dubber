# Coursera Video Dubber Chrome Extension

This Chrome extension allows dubbing Coursera videos from English to other languages (e.g., French) using Azure Cognitive Services.

##  Demo Video

<video src="https://github.com/user-attachments/assets/5881ef9f-74f5-456e-b4e3-9908b31bd431" controls width="600">
  Demo de l'application
</video>


## Features
- Activate the dubber via the extension popup
- Select output language
- Click the "Dub Video" button on Coursera pages to dub the video's transcript

## Installation
1. Download or clone this repository.
2. Copy `config.example.js` to `config.js` and fill in your Azure API keys:
   ```bash
   cp config.example.js config.js
   ```
3. Open Chrome and go to `chrome://extensions/`.
4. Enable "Developer mode".
5. Click "Load unpacked" and select the extension folder.
6. The extension is now installed.

## Usage
1. Go to a Coursera video page.
2. Click the extension icon and select language, then "Activate Dubber".
3. A "Dub Video" button will appear on the page.
4. Click it to dub the transcript (if available) and play the audio.

## Notes
- Requires the video page to have a transcript element with class 'transcript'. Adjust the selector in content.js if needed.
- For real-time dubbing, further development is needed.

## Security
- API keys are stored in `config.js` which is **excluded from Git** via `.gitignore`.
- Never commit `config.js` — only `config.example.js` (with placeholder values) is tracked.

## License

This project is licensed under the [MIT License](LICENSE).