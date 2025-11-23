import React, { useState } from 'react';
import { Cog6ToothIcon, UserPlusIcon, ArrowLeftOnRectangleIcon } from '@heroicons/react/24/outline';

// Dummy user data for now
const initialUsers = [
  { id: 1, username: 'user1', role: 'User' },
  { id: 2, username: 'user2', role: 'User' },
];

const Settings = ({ onClose }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [users, setUsers] = useState(initialUsers);
  const [newUsername, setNewUsername] = useState('');

  const handleLogin = (e) => {
    e.preventDefault();
    if (username === 'admin' && password === '12345678') {
      setIsAuthenticated(true);
      setError('');
    } else {
      setError('Invalid credentials');
    }
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setUsername('');
    setPassword('');
  };

  const handleAddUser = (e) => {
    e.preventDefault();
    if (newUsername.trim() === '') return;
    const newUser = {
      id: users.length + 1,
      username: newUsername,
      role: 'User',
    };
    setUsers([...users, newUser]);
    setNewUsername('');
  };

  return (
    <div className="fixed inset-0 bg-gray-900 bg-opacity-75 z-50 flex items-center justify-center">
      <div className="bg-brand-card rounded-lg p-8 w-full max-w-2xl">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold flex items-center">
            <Cog6ToothIcon className="h-8 w-8 mr-3" />
            Settings & Admin
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {!isAuthenticated ? (
          <form onSubmit={handleLogin}>
            <div className="mb-4">
              <label className="block text-slate-400 mb-2" htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-brand-dark border border-brand-subtle rounded px-3 py-2 text-white"
              />
            </div>
            <div className="mb-6">
              <label className="block text-slate-400 mb-2" htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-brand-dark border border-brand-subtle rounded px-3 py-2 text-white"
              />
            </div>
            {error && <p className="text-red-500 text-center mb-4">{error}</p>}
            <button type="submit" className="w-full bg-brand-accent-blue hover:bg-blue-600 text-white font-bold py-3 rounded-lg">
              Login
            </button>
          </form>
        ) : (
          <div>
            <div className="flex justify-between items-center mb-6">
              <p className="text-green-400">Admin authenticated</p>
              <button onClick={handleLogout} className="text-slate-400 hover:text-white flex items-center">
                <ArrowLeftOnRectangleIcon className="h-6 w-6 mr-2" />
                Logout
              </button>
            </div>
            
            <div className="mt-8">
              <h3 className="text-2xl font-bold mb-4">User Management</h3>
              <form onSubmit={handleAddUser} className="flex gap-4 mb-4">
                <input
                  type="text"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="New username"
                  className="flex-grow bg-brand-dark border border-brand-subtle rounded px-3 py-2 text-white"
                />
                <button type="submit" className="bg-brand-accent-green hover:opacity-90 text-white font-bold py-2 px-4 rounded-lg flex items-center">
                  <UserPlusIcon className="h-5 w-5 mr-2" />
                  Add User
                </button>
              </form>
              
              <div className="bg-brand-dark rounded-lg p-4">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-brand-subtle text-slate-400 text-sm">
                      <th className="p-2">ID</th>
                      <th className="p-2">Username</th>
                      <th className="p-2">Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map(user => (
                      <tr key={user.id} className="border-b border-brand-dark/50">
                        <td className="p-2">{user.id}</td>
                        <td className="p-2">{user.username}</td>
                        <td className="p-2">{user.role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Settings;
