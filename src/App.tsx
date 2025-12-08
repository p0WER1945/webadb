import { useState, useCallback } from 'react';
import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbWebUsbBackendManager } from '@yume-chan/adb-backend-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';

function App() {
  const [device, setDevice] = useState<Adb | null>(null);
  const [status, setStatus] = useState<string>('Disconnected');
  const [deviceInfo, setDeviceInfo] = useState<string>('');

  const connect = useCallback(async () => {
    try {
      setStatus('Requesting device...');
      const backend = await AdbWebUsbBackendManager.BROWSER!.requestDevice();
      
      if (!backend) {
        setStatus('No device selected');
        return;
      }

      setStatus('Connecting...');
      const connection = await backend.connect() as any;
      
      const credentialStore = new AdbWebCredentialStore();
      
      const transport = await AdbDaemonTransport.authenticate({
        serial: backend.serial,
        connection,
        credentialStore,
      });

      const adb = new Adb(transport);

      setDevice(adb);
      setStatus('Connected');
      setDeviceInfo(`${adb.banner.model} (${adb.banner.product}) - ${adb.banner.device}`);
      
    } catch (e: any) {
      console.error(e);
      setStatus(`Error: ${e.message}`);
      if (e.message && e.message.includes('No device selected')) {
        setStatus('Disconnected');
      }
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (device) {
      try {
        await device.close();
      } catch (e) {
        console.error('Error closing device:', e);
      }
      setDevice(null);
      setStatus('Disconnected');
      setDeviceInfo('');
    }
  }, [device]);

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4">
      <div className="bg-white p-8 rounded-lg shadow-lg max-w-md w-full text-center">
        <h1 className="text-3xl font-bold mb-6 text-gray-800">WebADB</h1>
        
        <div className="mb-8">
          <div className={`text-lg font-medium mb-2 ${status.startsWith('Error') ? 'text-red-500' : 'text-gray-600'}`}>
            Status: {status}
          </div>
          {deviceInfo && (
            <div className="text-sm text-gray-500 bg-gray-50 p-2 rounded">
              Device: {deviceInfo}
            </div>
          )}
        </div>

        {!device ? (
          <button
            onClick={connect}
            className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-lg transition duration-200 w-full"
          >
            Connect Android Device
          </button>
        ) : (
          <button
            onClick={disconnect}
            className="bg-red-500 hover:bg-red-600 text-white font-bold py-3 px-6 rounded-lg transition duration-200 w-full"
          >
            Disconnect
          </button>
        )}
        
        <p className="mt-4 text-xs text-gray-400">
          Note: Ensure USB debugging is enabled on your Android device.
        </p>
      </div>
    </div>
  );
}

export default App;
