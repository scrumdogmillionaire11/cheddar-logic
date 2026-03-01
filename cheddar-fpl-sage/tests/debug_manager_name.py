#!/usr/bin/env python3

"""
Quick test to see what the FPL entry API returns for team 711511
"""

import asyncio
import aiohttp
import json

async def test_team_data():
    async with aiohttp.ClientSession() as session:
        url = "https://fantasy.premierleague.com/api/entry/711511/"
        async with session.get(url) as response:
            if response.status == 200:
                data = await response.json()
                print("Team data from FPL API:")
                print(json.dumps(data, indent=2))
                
                first_name = data.get('player_first_name', '')
                last_name = data.get('player_last_name', '')
                print(f"\nFirst name: '{first_name}'")
                print(f"Last name: '{last_name}'")
                print(f"Combined: '{first_name} {last_name}'")
                print(f"Strip combined: '{(first_name + ' ' + last_name).strip()}'")
                
            else:
                print(f"Error: {response.status}")

if __name__ == "__main__":
    asyncio.run(test_team_data())