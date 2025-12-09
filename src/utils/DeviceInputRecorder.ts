import { Adb } from '@yume-chan/adb';
import { AndroidKeyCode, AndroidKeyEventAction } from '@yume-chan/scrcpy';

export interface DeviceInputEvent {
  type: 'touch' | 'key';
  // For touch
  x?: number; // Normalized 0-1
  y?: number; // Normalized 0-1
  action?: 'down' | 'up' | 'move';
  // For key
  keyCode?: AndroidKeyCode;
  keyAction?: AndroidKeyEventAction;
}

export class DeviceInputRecorder {
  private adb: Adb;
  private process: any; // AdbSubprocess
  private abortController: AbortController | null = null;
  private buffer = '';
  
  private touchDevicePath: string | null = null;
  private keyDevicePaths: string[] = [];
  
  private minX = 0;
  private maxX = 0;
  private minY = 0;
  private maxY = 0;

  constructor(adb: Adb) {
    this.adb = adb;
  }

  private async findDevices(): Promise<boolean> {
    try {
      if (!this.adb.subprocess.shellProtocol) {
        throw new Error('ADB Shell protocol not supported');
      }
      const process = await this.adb.subprocess.shellProtocol.spawn('getevent -p');
      const reader = process.stdout.pipeThrough(new TextDecoderStream()).getReader();
      let output = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += value;
      }

      // Simple parsing logic
      console.log('getevent -p output:', output);
      const devices = output.split('add device');
      
      // Reset
      this.touchDevicePath = null;
      this.keyDevicePaths = [];
      
      const touchCandidates: {path: string, name: string, maxX: number, maxY: number}[] = [];

      for (const device of devices) {
        const lines = device.split('\n');
        const firstLine = lines[0]; 
        const matchPath = firstLine.match(/: (.*)/);
        if (!matchPath) continue;
        
        const path = matchPath[1].trim();
        let name = '';
        const nameLine = lines.find(l => l.trim().startsWith('name:'));
        if (nameLine) {
            const matchName = nameLine.match(/name:\s*"(.*)"/);
            if (matchName) name = matchName[1];
        }

        // Check for Touch
        const hasX = device.includes('ABS_MT_POSITION_X') || device.includes('0035');
        const hasY = device.includes('ABS_MT_POSITION_Y') || device.includes('0036');

        if (hasX && hasY) {
            let minX = 0, maxX = 0, minY = 0, maxY = 0;
            for (const line of lines) {
              if (line.includes('ABS_MT_POSITION_X') || line.includes('0035')) {
                const match = line.match(/min (\d+), max (\d+)/);
                if (match) {
                  minX = parseInt(match[1], 10);
                  maxX = parseInt(match[2], 10);
                }
              }
              if (line.includes('ABS_MT_POSITION_Y') || line.includes('0036')) {
                const match = line.match(/min (\d+), max (\d+)/);
                if (match) {
                  minY = parseInt(match[1], 10);
                  maxY = parseInt(match[2], 10);
                }
              }
            }
            
            if (maxX > 0 && maxY > 0) {
                touchCandidates.push({ path, name, maxX, maxY });
            }
        }

        // Check for Keys (Power, Volume)
        // KEY_POWER (0074), KEY_VOLUMEUP (0073), KEY_VOLUMEDOWN (0072)
        const nameLower = name.toLowerCase();
        // Heuristic: Name contains "key", "gpio", "power", "vol"
        const isKeyDevice = nameLower.includes('key') || nameLower.includes('gpio') || 
                           nameLower.includes('power') || nameLower.includes('pwr') || 
                           nameLower.includes('vol') || nameLower.includes('button');

        const hasKeyCaps = device.includes('KEY_POWER') || device.includes('0074') || 
                           device.includes('KEY_VOLUMEUP') || device.includes('0073') || 
                           device.includes('KEY_VOLUMEDOWN') || device.includes('0072');
        
        if (isKeyDevice || hasKeyCaps) {
            // Avoid adding the touch device as a key device if possible, 
            // though some touchscreens have keys. 
            // But usually physical buttons are on separate devices like gpio_keys.
            // Let's add it. Duplicates handled by event loop.
            if (!this.keyDevicePaths.includes(path)) {
                this.keyDevicePaths.push(path);
                console.log(`Found key device: ${path} (${name})`);
            }
        }
      }

      // Select best touch device
      if (touchCandidates.length > 0) {
        const best = touchCandidates.sort((a, b) => {
            const nameA = a.name.toLowerCase();
            const nameB = b.name.toLowerCase();
            
            const isFpA = nameA.includes('fp') || nameA.includes('fingerprint');
            const isFpB = nameB.includes('fp') || nameB.includes('fingerprint');
            
            if (isFpA && !isFpB) return 1;
            if (!isFpA && isFpB) return -1;
            
            const scoreA = (nameA.includes('touchscreen') ? 10 : 0) + (nameA.includes('ts') ? 5 : 0);
            const scoreB = (nameB.includes('touchscreen') ? 10 : 0) + (nameB.includes('ts') ? 5 : 0);
            
            if (scoreA !== scoreB) return scoreB - scoreA;
            
            const areaA = a.maxX * a.maxY;
            const areaB = b.maxX * b.maxY;
            return areaB - areaA;
        })[0];
        
        this.touchDevicePath = best.path;
        this.maxX = best.maxX;
        this.maxY = best.maxY;
        console.log(`Selected touch device: ${best.path} (${best.name})`);
        
        // Remove touch device from key devices to avoid redundancy/confusion, 
        // unless we really want to capture keys from it (which we handle in touch logic mostly)
        // But actually, we want to listen to it. The filtering in start() handles specific event types.
      }

      return !!(this.touchDevicePath || this.keyDevicePaths.length > 0);
    } catch (e) {
      console.error('Failed to find devices', e);
    }
    return false;
  }

  async start(onEvent: (event: DeviceInputEvent) => void) {
    if (!this.touchDevicePath && this.keyDevicePaths.length === 0) {
      const found = await this.findDevices();
      if (!found) {
        throw new Error('No input devices found');
      }
    }

    this.abortController = new AbortController();
    
    if (!this.adb.subprocess.shellProtocol) {
        throw new Error('ADB Shell protocol not supported');
    }

    // Monitor all devices using getevent -l (no args)
    // This is more robust than passing multiple paths which might not be supported
    const cmd = `getevent -l`;
    console.log('Starting recording with:', cmd);
    
    this.process = await this.adb.subprocess.shellProtocol.spawn(cmd);
    
    // Check for stderr
    if (this.process.stderr) {
        const errReader = this.process.stderr.pipeThrough(new TextDecoderStream()).getReader();
        (async () => {
            try {
                while (true) {
                    const { done, value } = await errReader.read();
                    if (done) break;
                    if (value) console.error('getevent stderr:', value);
                }
            } catch (e) {
                // Ignore
            }
        })();
    }
    
    const reader = this.process.stdout.pipeThrough(new TextDecoderStream()).getReader();
    
    let currentX = -1;
    let currentY = -1;
    let isDown = false;
    
    let frameHasDown = false;
    let frameHasUp = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        this.buffer += value;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          // Format: [/dev/input/eventX:] [type] [code] [value]
          
          if (parts.length < 3) continue;

          // Determine source device
          let devicePath = parts[0];
          if (devicePath.endsWith(':')) {
              devicePath = devicePath.slice(0, -1);
          }
          
          // Filter out irrelevant devices
          const isTouchDevice = devicePath === this.touchDevicePath;
          const isKeyDevice = this.keyDevicePaths.includes(devicePath);
          
          if (!isTouchDevice && !isKeyDevice) continue;

          let typeIndex = parts.findIndex(p => p.startsWith('EV_'));
          if (typeIndex === -1) continue;
          
          const type = parts[typeIndex];
          const code = parts[typeIndex + 1];
          const valStr = parts[typeIndex + 2];

          if (type === 'EV_ABS') {
            if (!isTouchDevice) continue; // Only process ABS from touch device
            
            if (code === 'ABS_MT_POSITION_X') {
              currentX = parseInt(valStr, 16);
            } else if (code === 'ABS_MT_POSITION_Y') {
              currentY = parseInt(valStr, 16);
            }
          } else if (type === 'EV_KEY') {
             if (code === 'BTN_TOUCH' && isTouchDevice) {
                if (valStr === 'DOWN') {
                    frameHasDown = true;
                    isDown = true;
                } else if (valStr === 'UP') {
                    frameHasUp = true;
                    isDown = false;
                }
             } else {
                // Handle Keys from ANY monitored device (including touch device if it has keys)
                let keyCode: AndroidKeyCode | undefined;
                if (code === 'KEY_POWER' || code === '0074') keyCode = AndroidKeyCode.Power;
                else if (code === 'KEY_VOLUMEUP' || code === '0073') keyCode = AndroidKeyCode.VolumeUp;
                else if (code === 'KEY_VOLUMEDOWN' || code === '0072') keyCode = AndroidKeyCode.VolumeDown;
                
                if (keyCode !== undefined) {
                    const action = (valStr === 'DOWN' || valStr === '00000001') ? AndroidKeyEventAction.Down : 
                                   (valStr === 'UP' || valStr === '00000000') ? AndroidKeyEventAction.Up : undefined;
                    
                    if (action !== undefined) {
                        onEvent({
                            type: 'key',
                            keyCode,
                            keyAction: action
                        });
                    }
                }
             }
          } else if (type === 'EV_SYN' && code === 'SYN_REPORT') {
             // End of frame (mostly for touch)
             if (isTouchDevice && currentX !== -1 && currentY !== -1) {
                const normX = (currentX - this.minX) / (this.maxX - this.minX);
                const normY = (currentY - this.minY) / (this.maxY - this.minY);
                
                let action: 'down' | 'up' | 'move' | null = null;
                
                if (frameHasDown) {
                    action = 'down';
                } else if (frameHasUp) {
                    action = 'up';
                } else if (isDown) {
                    action = 'move';
                }

                if (action) {
                    onEvent({
                        type: 'touch',
                        x: normX,
                        y: normY,
                        action
                    });
                }
             }
             // Reset frame flags
             if (isTouchDevice) {
                frameHasDown = false;
                frameHasUp = false;
             }
          }
        }
      }
    } catch (e) {
      if (this.abortController?.signal.aborted) {
        console.log('Recording stopped');
      } else {
        console.error('Error reading events', e);
      }
    } finally {
        reader.releaseLock();
    }
  }

  stop() {
    this.abortController?.abort();
    if (this.process) {
      this.process.kill();
    }
  }
}
