import { Adb } from '@yume-chan/adb';

export interface DeviceInputEvent {
  type: 'touch';
  x: number; // Normalized 0-1
  y: number; // Normalized 0-1
  action: 'down' | 'up' | 'move';
}

interface TouchDeviceCandidate {
  path: string;
  name: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export class DeviceInputRecorder {
  private adb: Adb;
  private process: any; // AdbSubprocess
  private abortController: AbortController | null = null;
  private buffer = '';
  
  private devicePath: string | null = null;
  private minX = 0;
  private maxX = 0;
  private minY = 0;
  private maxY = 0;

  constructor(adb: Adb) {
    this.adb = adb;
  }

  private async findTouchDevice(): Promise<boolean> {
    try {
      if (!this.adb.subprocess.shellProtocol) {
        throw new Error('ADB Shell protocol not supported');
      }
      console.log('Finding touch device via getevent -p...');
      const process = await this.adb.subprocess.shellProtocol.spawn('getevent -p');
      const reader = process.stdout.pipeThrough(new TextDecoderStream()).getReader();
      let output = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += value;
      }

      console.log('getevent -p output len:', output.length);

      const candidates: TouchDeviceCandidate[] = [];

      // Robust parsing logic
      const devices = output.split('add device');
      for (const device of devices) {
        // Check for ABS_MT_POSITION_X (0035) and ABS_MT_POSITION_Y (0036)
        const hasX = /ABS_MT_POSITION_X|0035/.test(device);
        const hasY = /ABS_MT_POSITION_Y|0036/.test(device);

        if (hasX && hasY) {
          const lines = device.split('\n');
          const firstLine = lines[0]; 
          const matchPath = firstLine.match(/: (.*)/);
          
          if (matchPath) {
            const path = matchPath[1].trim();
            
            // Extract name
            let name = '';
            const nameLine = lines.find(l => l.includes('name:'));
            if (nameLine) {
                const matchName = nameLine.match(/name:\s*"(.*)"/);
                if (matchName) name = matchName[1];
            }

            let minX = 0, maxX = 0, minY = 0, maxY = 0;
            
            for (const line of lines) {
              if (/ABS_MT_POSITION_X|0035/.test(line)) {
                const match = line.match(/min (\d+), max (\d+)/);
                if (match) {
                  minX = parseInt(match[1], 10);
                  maxX = parseInt(match[2], 10);
                }
              }
              if (/ABS_MT_POSITION_Y|0036/.test(line)) {
                const match = line.match(/min (\d+), max (\d+)/);
                if (match) {
                  minY = parseInt(match[1], 10);
                  maxY = parseInt(match[2], 10);
                }
              }
            }
            
            if (path && maxX > 0 && maxY > 0) {
              candidates.push({ path, name, minX, maxX, minY, maxY });
            }
          }
        }
      }
      
      console.log('Touch device candidates:', candidates);

      if (candidates.length === 0) return false;

      // Selection Logic
      // Priority 1: Name contains "touchscreen" or exact match "vivo_ts" etc.
      // Priority 2: Name contains "ts" (but not "fp" unless no other choice)
      // Priority 3: Largest Area (MaxX * MaxY)

      const best = candidates.sort((a, b) => {
          const nameA = a.name.toLowerCase();
          const nameB = b.name.toLowerCase();
          
          const isFpA = nameA.includes('fp') || nameA.includes('fingerprint');
          const isFpB = nameB.includes('fp') || nameB.includes('fingerprint');
          
          // Avoid fingerprint readers if possible
          if (isFpA && !isFpB) return 1;
          if (!isFpA && isFpB) return -1;
          
          const scoreA = (nameA.includes('touchscreen') ? 10 : 0) + (nameA.includes('ts') ? 5 : 0);
          const scoreB = (nameB.includes('touchscreen') ? 10 : 0) + (nameB.includes('ts') ? 5 : 0);
          
          if (scoreA !== scoreB) return scoreB - scoreA;
          
          // Tie-breaker: Resolution
          const areaA = a.maxX * a.maxY;
          const areaB = b.maxX * b.maxY;
          return areaB - areaA;
      })[0];

      this.devicePath = best.path;
      this.minX = best.minX;
      this.maxX = best.maxX;
      this.minY = best.minY;
      this.maxY = best.maxY;
      
      console.log(`Selected touch device: ${this.devicePath} (${best.name}), X: ${this.minX}-${this.maxX}, Y: ${this.minY}-${this.maxY}`);
      return true;

    } catch (e) {
      console.error('Failed to find touch device', e);
    }
    return false;
  }

  async start(onEvent: (event: DeviceInputEvent) => void) {
    if (!this.devicePath) {
      const found = await this.findTouchDevice();
      if (!found) {
        throw new Error('No touch device found');
      }
    }

    this.abortController = new AbortController();
    if (!this.adb.subprocess.shellProtocol) {
        throw new Error('ADB Shell protocol not supported');
    }
    
    console.log(`Starting recording on ${this.devicePath}...`);
    // Use raw mode (no -l) for better compatibility and to avoid potential issues with label lookup
    try {
        this.process = await this.adb.subprocess.shellProtocol.spawn(`getevent ${this.devicePath}`);
    } catch (e) {
        console.error('Failed to spawn getevent', e);
        throw e;
    }
    
    // Monitor stderr for errors
    const stderrReader = this.process.stderr.pipeThrough(new TextDecoderStream()).getReader();
    (async () => {
        try {
            while (true) {
                const { done, value } = await stderrReader.read();
                if (done) break;
                if (value.trim()) {
                    console.error('getevent stderr:', value);
                }
            }
        } catch (e) {
            // ignore stderr errors
        } finally {
            stderrReader.releaseLock();
        }
    })();

    const reader = this.process.stdout.pipeThrough(new TextDecoderStream()).getReader();
    
    let currentX = -1;
    let currentY = -1;
    let isDown = false;
    let trackingId = -1;
    
    // Frame state
    let frameHasDown = false;
    let frameHasUp = false;
    let frameHasMove = false;

    let lineCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        this.buffer += value;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || ''; // Keep incomplete line

        for (const line of lines) {
            if (lineCount < 20) {
                console.log('Raw event:', line);
                lineCount++;
            }

          const parts = line.trim().split(/\s+/);
          
          let typeStr = '';
          let codeStr = '';
          let valStr = '';

          // Heuristic: Find EV_
          let typeIndex = parts.findIndex(p => p.startsWith('EV_'));
          if (typeIndex !== -1) {
            typeStr = parts[typeIndex];
            codeStr = parts[typeIndex + 1];
            valStr = parts[typeIndex + 2];
          } else {
            // Hex mode fallback
            // Handle optional device prefix like "/dev/input/event3: 0003 0035 ..."
            // We look for the last 3 parts which should be type, code, value
            if (parts.length >= 3) {
                 const p1 = parts[parts.length - 3];
                 const p2 = parts[parts.length - 2];
                 const p3 = parts[parts.length - 1];

                 // Validate hex format (usually 4 digits, 4 digits, 8 digits but can vary)
                 if (/^[0-9a-fA-F]+$/.test(p1) && /^[0-9a-fA-F]+$/.test(p2) && /^[0-9a-fA-F]+$/.test(p3)) {
                     const typeVal = parseInt(p1, 16);
                     if (typeVal === 3) typeStr = 'EV_ABS';
                     else if (typeVal === 1) typeStr = 'EV_KEY';
                     else if (typeVal === 0) typeStr = 'EV_SYN';
                     
                     if (typeStr) {
                         codeStr = p2;
                         valStr = p3;
                     }
                 }
            }
          }

          if (!typeStr) continue;

          // Normalize values
          const val = parseInt(valStr, 16);

          if (typeStr === 'EV_ABS') {
            if (codeStr === 'ABS_MT_POSITION_X' || codeStr === '0035') {
              currentX = val;
              frameHasMove = true;
            } else if (codeStr === 'ABS_MT_POSITION_Y' || codeStr === '0036') {
              currentY = val;
              frameHasMove = true;
            } else if (codeStr === 'ABS_MT_TRACKING_ID' || codeStr === '0039') {
              // Tracking ID: 
              // != -1 (0xffffffff) -> Down (new finger)
              // == -1 (0xffffffff) -> Up
              if (val === 0xffffffff || val === -1) {
                  frameHasUp = true;
                  trackingId = -1;
                  isDown = false;
              } else {
                  if (trackingId === -1) {
                      frameHasDown = true;
                      isDown = true;
                  }
                  trackingId = val;
              }
            }
          } else if (typeStr === 'EV_KEY') {
             if (codeStr === 'BTN_TOUCH' || codeStr === '014a') {
                if (valStr === 'DOWN' || val === 1) {
                    frameHasDown = true;
                    isDown = true;
                } else if (valStr === 'UP' || val === 0) {
                    frameHasUp = true;
                    isDown = false;
                }
             }
          } else if (typeStr === 'EV_SYN') {
             if (codeStr === 'SYN_REPORT' || codeStr === '0000') {
                 // End of frame
                 if (currentX !== -1 && currentY !== -1) {
                    const normX = (currentX - this.minX) / (this.maxX - this.minX);
                    const normY = (currentY - this.minY) / (this.maxY - this.minY);
                    
                    let action: 'down' | 'up' | 'move' | null = null;
                    
                    if (frameHasDown) {
                        action = 'down';
                    } else if (frameHasUp) {
                        action = 'up';
                    } else if (frameHasMove && isDown) {
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
                 frameHasDown = false;
                 frameHasUp = false;
                 frameHasMove = false;
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
