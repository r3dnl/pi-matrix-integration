# Pi Matrix Integration - Quick Start Guide

## 🚀 Get Started in 5 Minutes

### Step 1: Install the Extension

```bash
# Copy the extension to your Pi extensions directory
cp -r pi-matrix-integration ~/.pi/agent/extensions/

# Or if you're already in the right place:
# The extension is already at ~/.pi/agent/extensions/pi-matrix-integration/
```

### Step 2: Configure Matrix Account

**Option A: Use the setup script (Recommended)**
```bash
# Run the interactive setup
bash ~/.pi/agent/extensions/pi-matrix-integration/setup.sh

# Follow the prompts to:
# 1. Verify mtx installation
# 2. Create Matrix account for Pi
# 3. Configure the extension
```

**Option B: Manual Configuration**
```bash
# Edit the configuration file
nano ~/.pi/agent/extensions/pi-matrix-integration/config/matrix-config.json

# Update with your Matrix server details:
{
  "environment": "tst2",
  "homeserver": "tst2-matrix.r3d.nl",
  "userId": "@your-pi-bot:tst2-matrix.r3d.nl",
  "roomId": "!your-room-id:tst2-matrix.r3d.nl",
  "credentialsPath": "~/.config/mtx/accounts/your-pi-bot--tst2-matrix.r3d.nl/credentials.json",
  "mtxHome": "~/.config/mtx"
}
```

### Step 3: Start Pi and Connect

```bash
# Start Pi (the extension loads automatically)
pi

# In your Pi session, connect to Matrix
/matrix-connect

# You should see: "Connected to Matrix!"
```

### Step 4: Test the Integration

```
# Send a test message to Matrix
/matrix-send "Hello from Pi!"

# Check connection status
/matrix-status

# Get recent messages
/matrix-messages
```

### Step 5: Use Matrix for Decisions

Decisions use the RPIV `ask_user_question` dialogue, which this extension
mirrors into the room:

```
# Pi shows the decision questionnaire in the terminal AND in the room
# You answer on the terminal or in the room — whichever completes first wins
# Pi proceeds with your choice
```

## 📋 Common Commands

| Command | What it does |
|---------|--------------|
| `/matrix-connect` | Connect to Matrix room |
| `/matrix-disconnect` | Disconnect from Matrix |
| `/matrix-toggle` | Toggle Matrix on/off |
| `/matrix-status` | Show connection status |
| `/matrix-send Hello!` | Send message to Matrix |
| `/matrix-messages 5` | Show last 5 messages |

## 🎯 What Happens Automatically

Once connected, Pi will automatically:

1. **Broadcast Milestones** - When Pi completes a task, it sends an update to Matrix
   ```
   Pi: Analysis complete. [Milestone: Analysis Done]
   → Matrix: "🎯 Milestone: Analysis Done"
   ```

2. **Show Matrix Messages** - Messages from Matrix appear in Pi with clear attribution
   ```
   [Matrix] username: Let's proceed with option A
   ```

3. **Display Connection Status** - Footer shows Matrix connection info
   ```
   ✓ Matrix(tst2): !pi-updates:tst2-matrix.r3d.nl
   ```

4. **Mirror Decisions** - RPIV `ask_user_question` dialogues are mirrored
   into the room; answer in the terminal or the room, first one wins
   ```
   Pi shows the option dialogue in the terminal and the room
   → You reply (terminal or room); Pi proceeds with your choice
   ```

## 🔧 Troubleshooting

### "mtx command not found"
```bash
# Install mtx from your synapse-matrix repository
cd ~/code/homeops/synapse-matrix/tools/mtx
bash install.sh
```

### "Matrix not connected"
```
# Check your configuration
cat ~/.pi/agent/extensions/pi-matrix-integration/config/matrix-config.json

# Test mtx directly
mtx status -e tst2

# Verify credentials exist
ls ~/.config/mtx/accounts/
```

### Messages not appearing in Pi
```
# Check if polling is working
/matrix-messages

# Verify connection
/matrix-status

# Check mtx can read messages
mtx message read -r !your-room-id -e tst2
```

## 📖 Learn More

- **Full Documentation**: See `README.md`
- **Architecture**: See `DESIGN.md`
- **Project Summary**: See `SUMMARY.md`
- **Verification**: See `VERIFICATION.md`

## 🎉 You're Done!

The extension is now ready to use. Pi will automatically:
- Send milestone updates to Matrix
- Receive user responses from Matrix
- Use Matrix for decision-making
- Show connection status in the footer

Enjoy your Matrix-integrated Pi experience! 🎊
