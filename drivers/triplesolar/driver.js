'use strict';

const { Driver } = require('homey');
const fetch = require('node-fetch');

const TRIPLESOLAR_API = 'https://app.triplesolar.eu/graphql';

class TripleSolarDriver extends Driver {
  
  async onInit() {
    this.log('TripleSolar Driver has been initialized');

    // Register flow cards
    this._boilerModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('boiler_mode_changed');
    this._isBoilerModeCondition = this.homey.flow.getConditionCard('is_boiler_mode');
    this._setBoilerModeAction = this.homey.flow.getActionCard('set_boiler_mode');

    // Register handlers for flow cards
    this._isBoilerModeCondition.registerRunListener(async (args, state) => {
      const currentMode = await args.device.getCapabilityValue('onoff.boiler');
      return currentMode === true;
    });

    this._setBoilerModeAction.registerRunListener(async (args, state) => {
      const device = args.device;
      const newMode = args.mode === 'on';
      await device.onCapabilityBoilerMode(newMode);
      return true;
    });
  }

  // Method to activate the boiler mode changed trigger
  triggerBoilerModeChanged(device, tokens) {
    this._boilerModeChangedTrigger.trigger(device, tokens)
      .catch(this.error);
  }

  async onPair(session) {
    this.log('Pairing session started');
    
    let username = '';
    let password = '';
    let accessToken = '';
    let refreshToken = '';
    
    // Check if we already have app-wide stored credentials
    const appCredentials = this.homey.app.getCredentials();
    if (appCredentials) {
      this.log('Found stored credentials, will try to use them');
      accessToken = appCredentials.accessToken || '';
      refreshToken = appCredentials.refreshToken || '';
      username = appCredentials.username || '';
      password = appCredentials.password || '';
      
      // Auto-advance to list_devices if we have valid tokens
      if (accessToken && refreshToken) {
        this.log('Valid tokens found, auto-advancing to device discovery');
        session.showView('list_devices');
      }
    }

    session.setHandler('login', async (data) => {
      try {
        this.log('Login handler called with data:', JSON.stringify(data));
        username = data.username;
        password = data.password;

        this.log(`Attempting to login with username: ${username}`);
        const response = await fetch('https://app.triplesolar.eu/auth/login', {
          method: 'POST',
          headers: {
            'accept': '*/*',
            'content-type': 'application/json',
            'origin': 'https://app.triplesolar.eu',
            'user-agent': 'Homey/TripleSolar'
          },
          body: JSON.stringify({
            email: username,
            password: password
          })
        });

        this.log('Login response status:', response.status);
        
        // Lees de response text en log deze voor debugging (zonder gevoelige details)
        const responseText = await response.text();
        this.log(`Login response received (${responseText.length} characters)`);
        
        let result;
        try {
          result = JSON.parse(responseText);
        } catch (jsonError) {
          this.error('Could not parse login response as JSON:', jsonError);
          return false;
        }
        
        // Log maar verberg sensitieve data
        if (result.accessToken) {
          this.log('Access token received');
          accessToken = result.accessToken;
        } else {
          this.error('No access token in response');
          return false;
        }
        
        if (result.refreshToken) {
          this.log('Refresh token received');
          refreshToken = result.refreshToken;
        } else {
          this.error('No refresh token in response');
          return false;
        }

        // Store credentials app-wide
        await this.homey.app.storeCredentials({
          username,
          password,
          accessToken,
          refreshToken,
          timestamp: Date.now()
        });

        this.log('Login successful');
        return true;
      } catch (error) {
        this.error('Login failed with error:', error.message);
        this.error('Error stack:', error.stack);
        return false;
      }
    });

    session.setHandler('list_devices', async () => {
      try {
        this.log('List devices handler called with accessToken:', accessToken ? 'Valid token present' : 'No valid token');
        // Get the interfaces first
        this.log('Making API request to TripleSolar GraphQL endpoint');
        
        // GraphQL query for debugging
        const graphqlQuery = {
          operationName: 'Interfaces',
          variables: {},
          query: `query Interfaces {
  interfaces {
    ...InterfaceFields
    __typename
  }
}

fragment InterfaceFields on Interface {
  id
  name
  isOnline
  lastMessage
  pvtHeatPump(fromDB: true) {
    errors
    __typename
  }
  __typename
}`
        };
        
        this.log('GraphQL query:', JSON.stringify(graphqlQuery));
        
        const response = await fetch(TRIPLESOLAR_API, {
          method: 'POST',
          headers: {
            'accept': '*/*',
            'content-type': 'application/json',
            'authorization': `Bearer ${accessToken}`,
            'origin': 'https://app.triplesolar.eu',
            'user-agent': 'Homey/TripleSolar'
          },
          body: JSON.stringify(graphqlQuery)
        });

        this.log('API response status:', response.status);
        
        // Full response for debugging
        const responseText = await response.text();
        this.log('API response text:', responseText);
        
        // Parse the JSON after logging the full text
        let result;
        try {
          result = JSON.parse(responseText);
        } catch (jsonError) {
          this.error('Failed to parse JSON response:', jsonError.message);
          return [];
        }
        
        if (result.errors) {
          this.log('GraphQL errors:', JSON.stringify(result.errors));
        }
        
        // Check different parts of the response
        this.log('Response data exists:', result.data !== undefined);
        if (result.data) {
          this.log('Interfaces exists:', result.data.interfaces !== undefined);
          if (result.data.interfaces) {
            this.log('Interfaces is array:', Array.isArray(result.data.interfaces));
            this.log('Interfaces length:', result.data.interfaces.length);
          }
        }
        
        if (result.data && result.data.interfaces && Array.isArray(result.data.interfaces) && result.data.interfaces.length > 0) {
          this.log(`Found ${result.data.interfaces.length} interfaces in response`);
          const devices = result.data.interfaces.map(interfaceObj => {
            this.log(`Processing interface: ${interfaceObj.name}, ID: ${interfaceObj.id}, Online: ${interfaceObj.isOnline}`);
            return {
              name: interfaceObj.name,
              data: {
                id: interfaceObj.id
              },
              store: {
                username: username,
                password: password,
                accessToken: accessToken,
                refreshToken: refreshToken,
                lastMessage: interfaceObj.lastMessage
              },
              capabilities: ['target_temperature', 'measure_temperature', 'measure_power', 'onoff.boiler'],
              available: interfaceObj.isOnline
            };
          });
          
          this.log('Returning devices list with length:', devices.length);
          return devices;
        }

        this.log('No valid interfaces found in response data');
        if (result.data) {
          this.log('Response data:', JSON.stringify(result.data));
        } else {
          this.log('No data in response');
        }
        
        // Test alternatieve GraphQL query als eerste query faalt
        this.log('Trying alternative GraphQL query...');
        const alternativeQuery = {
          query: `{
            interfaces {
              id
              name
              isOnline
            }
          }`
        };
        
        this.log('Alternative query:', JSON.stringify(alternativeQuery));
        
        const altResponse = await fetch(TRIPLESOLAR_API, {
          method: 'POST',
          headers: {
            'accept': '*/*',
            'content-type': 'application/json',
            'authorization': `Bearer ${accessToken}`,
            'origin': 'https://app.triplesolar.eu',
            'user-agent': 'Homey/TripleSolar'
          },
          body: JSON.stringify(alternativeQuery)
        });
        
        this.log('Alternative API response status:', altResponse.status);
        const altResponseText = await altResponse.text();
        this.log('Alternative API response text:', altResponseText);
        
        // Test alternative API connection to see if we can get any device information
        try {
          const altResult = JSON.parse(altResponseText);
          if (altResult.data && altResult.data.interfaces && Array.isArray(altResult.data.interfaces) && altResult.data.interfaces.length > 0) {
            this.log(`Found ${altResult.data.interfaces.length} interfaces using alternative query`);
            const devices = altResult.data.interfaces.map(interfaceObj => {
              return {
                name: interfaceObj.name || 'TripleSolar Heat Pump',
                data: {
                  id: interfaceObj.id
                },
                store: {
                  username: username,
                  password: password,
                  accessToken: accessToken,
                  refreshToken: refreshToken
                },
                capabilities: ['target_temperature', 'measure_temperature', 'measure_power', 'onoff.boiler'],
                available: interfaceObj.isOnline
              };
            });
            
            this.log('Returning devices from alternative query:', devices.length);
            return devices;
          }
        } catch (err) {
          this.error('Failed to parse alternative query response:', err);
        }
        
        // If both queries fail, inform the user that no devices could be found
        this.log('No devices found via API, please check your TripleSolar account');
        return [];
      } catch (error) {
        this.error('Failed to list devices with error:', error.message);
        this.error('Error stack:', error.stack);
        return [];
      }
    });
  }
}

module.exports = TripleSolarDriver; 