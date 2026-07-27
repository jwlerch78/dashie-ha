/* ============================================================
   Mock Data — replaced with Supabase calls in production
   ============================================================ */

const MockData = {
    // Identity is populated from real auth in app.js (_showApp). Defaults are
    // BLANK on purpose — a placeholder like "john@example.com" here would render
    // as a convincing fake identity if the app ever shows before/without real
    // auth (the half-auth bug, now also guarded by _handleAuthFailure).
    user: {
        email: '',
        name: '',
        initials: '',
        picture: '',   // Google avatar URL when signed in (see app.js init)
        provider: 'Google',
    },

    subscription: {
        status: 'active',
        plan: '$2.99/mo',
        renewsAt: '2026-05-15',
    },

    credits: {
        included: 1.24,
        purchased: 3.03,
        total: 4.27,
        purchasedExpiresAt: '2027-04-16',
    },

    devices: [
        {
            id: 'fire-tv-kitchen',
            name: 'Kitchen Fire TV',
            type: 'Fire TV 4K',
            icon: '🖥',
            online: true,
            lastCheckIn: '2 min ago',
            settings: {
                layout: 'Widgets',
                theme: 'Default',
                zoom: '100%',
                sidebarSize: 'Medium',
                sleepTime: '10:00 PM',
                wakeTime: '6:30 AM',
                sleepMethod: 'Power Off',
                screensaver: 'Photos',
                screensaverDelay: '2 minutes',
                wakeMode: 'Face Detection',
                personality: 'Friendly',
                voice: 'Rachel',
            },
        },
        {
            id: 'samsung-tablet',
            name: 'Family Room Tablet',
            type: 'Samsung SM-X200',
            icon: '📱',
            online: false,
            lastCheckIn: '2 hours ago',
            settings: {
                layout: 'Single Panel',
                theme: 'Midnight',
                zoom: '110%',
                sidebarSize: 'Large',
                sleepTime: '11:00 PM',
                wakeTime: '7:00 AM',
                sleepMethod: 'Screen Off',
                screensaver: 'Clock',
                screensaverDelay: '5 minutes',
                wakeMode: 'Touch',
                personality: 'Friendly',
                voice: 'Adam',
            },
        },
        {
            id: 'mio-15',
            name: 'Bedroom Mio 15"',
            type: 'rk3576_u / WF2489T',
            icon: '🖥',
            online: true,
            lastCheckIn: '30 sec ago',
            settings: {
                layout: 'Widgets',
                theme: 'Midnight',
                zoom: '100%',
                sidebarSize: 'Medium',
                sleepTime: '9:30 PM',
                wakeTime: '6:00 AM',
                sleepMethod: 'Power Off',
                screensaver: 'Photos',
                screensaverDelay: '2 minutes',
                wakeMode: 'Face Detection',
                personality: 'Calm',
                voice: 'Rachel',
            },
        },
        {
            id: 'mio-32',
            name: 'Living Room Mio 32"',
            type: 'rk3576_u',
            icon: '🖥',
            online: true,
            lastCheckIn: '1 min ago',
            settings: {
                layout: 'Widgets',
                theme: 'Default',
                zoom: '90%',
                sidebarSize: 'Small',
                sleepTime: '10:30 PM',
                wakeTime: '6:30 AM',
                sleepMethod: 'Power Off',
                screensaver: 'Photos',
                screensaverDelay: '3 minutes',
                wakeMode: 'Motion',
                personality: 'Friendly',
                voice: 'Aria',
            },
        },
    ],

    family: [
        { id: '1', name: 'John Lerch', nickname: '', role: 'Owner', color: '#3b82f6', email: 'john@example.com', googleLinked: true, notes: '' },
        { id: '2', name: 'Sarah', nickname: '', role: 'Parent', color: '#22c55e', email: 'sarah@example.com', googleLinked: true, notes: '' },
        { id: '3', name: 'Emma', nickname: 'Em', role: 'Child', color: '#a855f7', email: '', googleLinked: false, notes: 'Loves dinosaurs' },
    ],

    calendarAccounts: [
        { id: '1', email: 'john@example.com', color: '#3b82f6', calendars: 6 },
        { id: '2', email: 'sarah@example.com', color: '#22c55e', calendars: 4 },
        { id: '3', email: 'work@company.com', color: '#a855f7', calendars: 2 },
    ],

    calendars: [
        { id: '1', name: 'Personal', account: 'john@example.com', color: '#3b82f6', active: true, category: 'Family' },
        { id: '2', name: 'Family Events', account: 'sarah@example.com', color: '#22c55e', active: true, category: 'Family' },
        { id: '3', name: 'Work', account: 'john@example.com', color: '#ef4444', active: true, category: 'Work' },
        { id: '4', name: 'Kids School', account: 'sarah@example.com', color: '#eab308', active: true, category: 'Kids' },
        { id: '5', name: 'Birthdays', account: 'john@example.com', color: '#3b82f6', active: false, category: '' },
        { id: '6', name: 'Holidays', account: 'sarah@example.com', color: '#22c55e', active: false, category: '' },
    ],

    calendarSettings: {
        startWeek: 'Monday',
        scrollTime: '7:00 AM',
    },

    choresSettings: {
        choresEnabled: true,
        rewardsEnabled: true,
        anyoneCanComplete: false,
        participants: ['John', 'Sarah', 'Emma'],
    },

    chores: [
        { id: '1', name: 'Take out trash', frequency: 'Daily', assignee: 'Emma', points: 10 },
        { id: '2', name: 'Clean dishes', frequency: 'Daily', assignee: 'Everyone', points: 5 },
        { id: '3', name: 'Vacuum living room', frequency: 'Weekly', assignee: 'Sarah', points: 20 },
        { id: '4', name: 'Feed the dog', frequency: 'Daily', assignee: 'Emma', points: 5 },
        { id: '5', name: 'Tidy bedroom', frequency: 'Weekly', assignee: 'Everyone', points: 15 },
    ],

    rewards: [
        { id: '1', name: 'Extra Screen Time', description: '30 minutes of extra screen time', cost: 50 },
        { id: '2', name: 'Pick Dinner', description: 'Choose what the family has for dinner', cost: 30 },
        { id: '3', name: 'Movie Night Pick', description: 'Pick the movie for family movie night', cost: 40 },
        { id: '4', name: 'Stay Up Late', description: '30 minutes past bedtime on a weekend', cost: 60 },
        { id: '5', name: 'Small Toy', description: 'Trip to the store for a small toy (under $10)', cost: 100 },
    ],

    locationsSettings: {
        trackingEnabled: true,
        travelTimes: true,
        trafficModel: 'Best Guess',
        earlyArrival: 5,
    },

    savedLocations: [
        { id: '1', name: 'Home', icon: '🏠', address: '123 Main St, Anytown' },
        { id: '2', name: 'School', icon: '🏫', address: '456 Oak Ave, Anytown' },
        { id: '3', name: 'Work', icon: '💼', address: '789 Business Blvd' },
    ],

    photoSettings: {
        source: 'Google Drive',
        folder: 'Family Photos',
        photoCount: 847,
        lastSync: '2 hours ago',
        transitionTime: '5 seconds',
        displayDuration: '30 seconds',
        transitionStyle: 'Fade',
        photoOrder: 'Random',
    },

    usage: [
        { service: 'Claude Sonnet 4.5', count: '287 queries', cost: 0.86, type: 'llm', pct: 50 },
        { service: 'Claude Haiku', count: '55 queries', cost: 0.02, type: 'llm', pct: 3 },
        { service: 'ElevenLabs TTS', count: '412 calls', cost: 0.41, type: 'tts', pct: 24 },
        { service: 'Deepgram STT', count: '342 calls', cost: 0.17, type: 'stt', pct: 10 },
        { service: 'GPT-4o', count: '28 queries', cost: 0.27, type: 'llm', pct: 16 },
    ],
};
